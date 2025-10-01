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
import { Actions, buildQuery } from '../../../core';

export interface HttpServiceOptions {
  type: 'http';
  host: string; // required
  port: number; // required
  cors?: { enabled?: boolean; origin?: string | string[] };
  tls?: { key: string; cert: string; ca?: string } | null; // if set -> https
  maxBodySizeMb?: number;
  webhook?: { url: string; pingUrl?: string; token?: string; timeoutMs?: number };
  ping?: { staleMs?: number; factor?: number; minMs?: number; maxMs?: number; password?: string };
  /** Optional override for how long we wait for ACK after sending a batch. */
  ackTimeoutMs?: number;
}

/**
 * HTTP transport (server-side)
 * -----------------------------------------------------------------------------
 * Responsibilities:
 *  - Owns HTTP/HTTPS server and exposes POST /query → bridges to Nest CQRS QueryBus.
 *  - If webhook is configured, actively sends:
 *      * POST {webhook.pingUrl} with { action: Ping } on a backoff schedule.
 *      * POST {webhook.url} with messages (batches, etc.) via send().
 *
 * Contract notes:
 *  - No webhook → OK: we neither ping nor send batches.
 *  - With webhook → BOTH webhook.url (batches) AND webhook.pingUrl (pings) are REQUIRED.
 *    Ping always POSTs to pingUrl; it never falls back to webhook.url.
 *  - Incoming replies are parsed:
 *      * { action: Pong } is processed in heartbeat (startHeartbeat), marking the peer online.
 *      * { action: OutboxStreamAck } resolves waitForAck().
 *  - Password (opts.ping?.password) is optional; validated only on incoming Pong.
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

    // Validate webhook config early
    if (opts.webhook) {
      if (!opts.webhook.url) throw new Error('HTTP: webhook.url is required when webhook is set');
      if (!opts.webhook.pingUrl) throw new Error('HTTP: webhook.pingUrl is required when webhook is set');
    }

    // --- Middlewares ---------------------------------------------------------
    if (opts.cors?.enabled) {
      this.app.use(cors({ origin: opts.cors.origin ?? true }));
    }
    this.app.use(bodyParser.json({ limit: `${opts.maxBodySizeMb ?? 5}mb` }));

    // --- /query endpoint (sync bridge to CQRS QueryBus) ----------------------
    // Input:  { name: string; dto?: any }
    // Output: { ok: true, data } | { ok: false, err }
    this.app.post('/query', async (req, res) => {
      try {
        const body = (req.body ?? {}) as { name: string; dto?: any };
        if (!body || typeof body.name !== 'string') {
          return res.status(400).json({ ok: false, err: 'Invalid query payload' });
        }

        const result = await this.queryBus.execute(buildQuery(body));
        return res.status(200).json({ ok: true, data: result });
      } catch (e: any) {
        return res.status(500).json({ ok: false, err: String(e?.message ?? e ?? 'internal error') });
      }
    });

    // --- Server bootstrap ----------------------------------------------------
    if (opts.tls) {
      const key = fs.readFileSync(opts.tls.key);
      const cert = fs.readFileSync(opts.tls.cert);
      const ca = opts.tls.ca ? fs.readFileSync(opts.tls.ca) : undefined;
      this.server = https.createServer({ key, cert, ca }, this.app);
    } else {
      this.server = http.createServer(this.app);
    }

    this.server.listen(opts.port, opts.host);
    this.log.log(`HTTP server listening at ${opts.host}:${opts.port}`);

    // --- Heartbeat -----------------------------------------------------------
    // Start only when webhook is present; otherwise remain passive.
    if (opts.webhook) this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // --- Health/state ------------------------------------------------------
  /**
   * Returns whether the peer is considered "online":
   *  - we must have received a valid Pong recently (within staleMs),
   *  - and the transport is marked online.
   */
  isOnline(): boolean {
    const stale = this.opts.ping?.staleMs ?? 15_000;
    return this.online && Date.now() - this.lastPongAt < stale;
  }

  /**
   * Spin-waits until `isOnline()` becomes true or a deadline is reached.
   * Each loop triggers a backoff reset to accelerate a near-future ping attempt.
   */
  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      if (this.isOnline()) return;
      // Nudge heartbeat to emit next Ping earlier
      this.heartbeatReset?.();
      await delay(1000);
    }
    throw new Error('HTTP: peer is offline (no valid Pong)');
  }

  // --- Outbound send + ACK handling -----------------------------------------
  /**
   * Sends an outbound message (typically a batch envelope) to webhook.url.
   * The receiver is expected to reply with:
   *  - { action: OutboxStreamAck, payload } for batches
   *
   * Notes:
   *  - If no webhook is configured → throws (cannot deliver).
   *  - If the reply is an OutboxStreamAck and waitForAck() is pending, it resolves.
   *
   * Why NOT process Pong here?
   *  - send() targets webhook.url (batches). Pong belongs to heartbeat (pingUrl),
   *    so online state is updated in startHeartbeat() instead.
   */
  async send(msg: Message | string): Promise<void> {
    const url = this.opts.webhook?.url;
    if (!url) throw new Error('HTTP: webhook.url is required');

    const body = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.log.debug(`HTTP send action=${typeof msg === 'string' ? '<string>' : (msg as Message).action}`);

    const resText = await this.post(url, body, this.opts.webhook?.token, this.opts.webhook?.timeoutMs);
    const parsed = safeParse(resText) as Message | null;
    if (!parsed) return;

    if (parsed.action === Actions.OutboxStreamAck && parsed.payload) {
      const ack = parsed.payload as OutboxStreamAckPayload;
      if (this.pendingAck) this.pendingAck.resolve(ack);
      else this.lastAckBuffer = ack;
    }
  }

  async waitForAck(deadlineMs?: number): Promise<OutboxStreamAckPayload> {
    // Compute default deadline if not provided: must exceed client processing timeout.
    const defaultAckMs = Math.max(3000, (this.opts.webhook?.timeoutMs ?? 2000) + 1500, this.opts.ackTimeoutMs ?? 0);
    const finalDeadline = deadlineMs && deadlineMs > 0 ? deadlineMs : defaultAckMs;

    if (this.lastAckBuffer) {
      const ack = this.lastAckBuffer;
      this.lastAckBuffer = null;
      return ack;
    }
    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error('HTTP: ACK timeout'));
      }, finalDeadline);
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

  // --- Heartbeat (Ping publisher + Pong processing) --------------------------
  /**
   * Periodically POSTs { action: Ping } to webhook.pingUrl using exponential backoff.
   * - No password is included in Ping (only validated on Pong).
   * - Token (x-transport-token) and timeout are reused from webhook options.
   * - Backoff can be reset by waitForOnline() loops to speed up the next ping.
   * - IMPORTANT: Parses the reply; if it's a valid Pong, marks the peer as online.
   */
  private startHeartbeat() {
    const multiplier = this.opts.ping?.factor ?? 1.6;
    const interval = this.opts.ping?.minMs ?? 600;
    const maxInterval = this.opts.ping?.maxMs ?? 5_000;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;

        // Outbound Ping (no password in request)
        const ping: Message = {
          action: Actions.Ping,
          timestamp: Date.now(),
        };
        try {
          const resText = await this.post(
            this.requirePingUrl(),
            JSON.stringify(ping),
            this.opts.webhook?.token,
            this.opts.webhook?.timeoutMs
          );
          const parsed = safeParse(resText) as Message | null;
          if (parsed?.action === Actions.Pong) {
            // Validate password (if expected)
            const want = this.opts.ping?.password;
            const got = (parsed.payload as any)?.password;
            if (!want || want === got) {
              this.online = true;
              this.lastPongAt = Date.now();
              this.log.debug('HTTP pong ok');
              return; // success; next backoff step will start from min
            }
          }

          // If we fell through — pong is invalid
          this.online = false;
          this.log.warn('HTTP pong invalid');
        } catch (e: any) {
          // Network/timeout
          this.online = false;
          this.log.warn(`HTTP ping failed: ${String(e?.message ?? e)}`);
        }
      },
      { multiplier, interval, maxInterval }
    );
  }

  private stopHeartbeat() {
    try {
      this.heartbeatController?.destroy();
    } finally {
      this.heartbeatController = null;
    }
  }

  private requirePingUrl(): string {
    const url = this.opts.webhook?.pingUrl;
    if (!url) throw new Error('HTTP: webhook.pingUrl is required when webhook is set');
    return url;
  }

  // --- Low-level HTTP helper --------------------------------------------------
  /** POST with hard timeout and token; rejects on non-2xx. */
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
          port: url.port,
          path: url.pathname + (url.search || ''),
          headers,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (status < 200 || status >= 300) return reject(new Error(`HTTP ${status} ${text}`.trim()));
            resolve(text);
          });
        }
      );

      // Hard timeout for the entire request
      req.setTimeout(Math.max(1, timeoutMs), () => {
        req.destroy(new Error('request timeout'));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

// --- Small local helpers -----------------------------------------------------
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
