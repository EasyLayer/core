import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { URL } from 'node:url';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { QueryBus } from '@easylayer/common/cqrs';
import type { Message, TransportPort, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';

export interface HttpServiceOptions {
  type: 'http';
  host: string; // required
  port: number; // required
  cors?: { enabled?: boolean; origin?: string | string[] };
  tls?: { key: string; cert: string; ca?: string } | null; // if set -> https
  maxBodySizeMb?: number;
  webhook?: { url: string; pingUrl?: string; token?: string; timeoutMs?: number };
  ping?: { staleMs?: number; factor?: number; minMs?: number; maxMs?: number; password?: string };
}

/**
 * HTTP transport
 * - Owns HTTP/HTTPS server and handles POST /query via QueryBus.
 * - Sends webhooks (batch/ping).
 */
@Injectable()
export class HttpTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'http' as const;

  private readonly log = new Logger(HttpTransportService.name);
  private readonly app = express();
  private readonly server: http.Server | https.Server;

  private online = false;
  private lastPongAt = 0;
  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: {
    resolve: (v: OutboxStreamAckPayload) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  constructor(
    private readonly opts: HttpServiceOptions,
    private readonly queryBus: QueryBus
  ) {
    if (!opts.host || !opts.port) throw new Error('HTTP: host/port are required');

    if (opts.cors?.enabled) {
      this.app.use(cors({ origin: opts.cors.origin ?? true }));
    }
    this.app.use(bodyParser.json({ limit: `${opts.maxBodySizeMb ?? 5}mb` }));

    // ----- QUERY SECTION -----
    this.app.post('/query', async (req, res) => {
      try {
        const body = (req.body ?? {}) as { name?: string; data?: any };
        if (!body || typeof body.name !== 'string') {
          res.status(400).json({ ok: false, err: 'Invalid query payload' });
          return;
        }
        const query = { name: body.name, data: body.data } as any;
        const result = await this.queryBus.execute(query);
        const reply: Message = {
          action: Actions.QueryResponse,
          payload: { ok: true, data: result },
          timestamp: Date.now(),
        };
        res.status(200).json(reply.payload);
      } catch (e: any) {
        this.log.error(`HTTP /query error: ${e?.message ?? e}`);
        res.status(500).json({ ok: false, err: String(e?.message ?? e) });
      }
    });

    this.server = opts.tls
      ? https.createServer(
          {
            key: fs.readFileSync(opts.tls.key),
            cert: fs.readFileSync(opts.tls.cert),
            ca: opts.tls.ca ? fs.readFileSync(opts.tls.ca) : undefined,
          },
          this.app
        )
      : http.createServer(this.app);

    this.server.listen(opts.port, opts.host);
    this.log.log(`HTTP server listening at ${opts.host}:${opts.port}`);

    // ----- BATCH/PING SECTION -----
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ----- BATCH/PING SECTION -----
  isOnline(): boolean {
    const stale = this.opts.ping?.staleMs ?? 15_000;
    return this.online && Date.now() - this.lastPongAt < stale;
  }

  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!this.isOnline()) {
      this.heartbeatReset?.();
      if (this.isOnline()) break;
      if (Date.now() - start >= deadlineMs) throw new Error('HTTP: not online');
      await delay(120);
    }
  }

  async send(msg: Message | string): Promise<void> {
    const url = this.opts.webhook?.url;
    if (!url) throw new Error('HTTP: webhook.url is required');

    const body = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.log.debug(`HTTP send action=${typeof msg === 'string' ? '<string>' : (msg as Message).action}`);

    const res = await this.post(url, body, this.opts.webhook?.token, this.opts.webhook?.timeoutMs);
    const parsed = safeParse(res) as Message | null;
    if (!parsed) return;

    if (parsed.action === Actions.Pong) {
      const pw = (parsed.payload as any)?.password;
      const ok = this.opts.ping?.password ? pw === this.opts.ping.password : true;
      if (ok) {
        this.lastPongAt = Date.now();
        this.online = true;
        this.log.verbose('HTTP pong accepted');
      }
      return;
    }

    if (parsed.action === Actions.OutboxStreamAck && parsed.payload) {
      const ack = parsed.payload as OutboxStreamAckPayload;
      if (this.pendingAck) this.pendingAck.resolve(ack);
      else this.lastAckBuffer = ack;
    }
  }

  async waitForAck(deadlineMs = 2_000): Promise<OutboxStreamAckPayload> {
    if (this.lastAckBuffer) {
      const ack = this.lastAckBuffer;
      this.lastAckBuffer = null;
      return ack;
    }
    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error('HTTP: ACK timeout'));
      }, deadlineMs);
      this.pendingAck = {
        resolve: (v) => {
          clearTimeout(timer);
          this.pendingAck = null;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pendingAck = null;
          reject(e);
        },
        timer,
      };
    });
  }

  private startHeartbeat() {
    const multiplier = this.opts.ping?.factor ?? 1.6;
    const interval = this.opts.ping?.minMs ?? 600;
    const maxInterval = this.opts.ping?.maxMs ?? 5000;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;

        // Ping does not include password.
        const ping: Message = {
          action: Actions.Ping,
          timestamp: Date.now(),
        };
        try {
          await this.post(
            this.opts.webhook?.pingUrl ?? this.opts.webhook?.url!,
            JSON.stringify(ping),
            this.opts.webhook?.token,
            this.opts.webhook?.timeoutMs
          );
          this.log.verbose('HTTP ping published');
        } catch (e: any) {
          this.log.debug(`HTTP ping error: ${e?.message ?? e}`);
        }
      },
      { interval, multiplier, maxInterval }
    );
  }

  private stopHeartbeat() {
    this.heartbeatController?.destroy?.();
    this.heartbeatController = null;
    this.heartbeatReset = null;
  }

  private async post(urlStr: string, body: string, token?: string, timeoutMs = 2000): Promise<string> {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const agent = isHttps ? https : http;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    };
    if (token) headers['x-transport-token'] = token;

    return new Promise<string>((resolve, reject) => {
      const req = agent.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + (url.search || ''),
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
