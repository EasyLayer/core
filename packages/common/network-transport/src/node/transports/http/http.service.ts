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

        const reply: Message = {
          action: Actions.QueryResponse,
          payload: { ok: true, data: result },
          timestamp: Date.now(),
        };
        return res.status(200).json(reply.payload);
      } catch (e: any) {
        this.log.debug(`HTTP /query error: ${e?.message ?? e}`);

        // Normalize the "No handler found" shape → consistent server response
        if (e?.message?.includes('No handler found')) {
          return res
            .status(500)
            .json({ ok: false, err: `Query handler not found for: ${req.body?.name ?? 'unknown'}` });
        }

        return res.status(500).json({ ok: false, err: String(e?.message ?? e) });
      }
    });

    // --- Webhook contract validation ----------------------------------------
    // No webhook: allowed → we won't send batches nor pings at all.
    if (opts.webhook) {
      if (!opts.webhook.url) {
        throw new Error('HTTP: webhook.url is required when webhook is provided');
      }
      if (!opts.webhook.pingUrl) {
        throw new Error('HTTP: webhook.pingUrl is required when webhook is provided');
      }

      // Optional sanity checks: avoid path collisions on the receiver
      const wUrl = new URL(opts.webhook.url);
      const pUrl = new URL(opts.webhook.pingUrl);
      const wPath = (wUrl.pathname || '/').replace(/\/+$/, '') || '/';
      const pPath = (pUrl.pathname || '/').replace(/\/+$/, '') || '/';
      if (wPath === pPath) {
        throw new Error('HTTP: webhook.pingUrl must differ from webhook.url path');
      }
    }

    // --- HTTP/HTTPS server ---------------------------------------------------
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

    // --- Heartbeat -----------------------------------------------------------
    // Start only when webhook is present; otherwise remain passive.
    if (opts.webhook) this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // --- Health/state ----------------------------------------------------------
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
    while (!this.isOnline()) {
      this.heartbeatReset?.();
      if (this.isOnline()) break;
      if (Date.now() - start >= deadlineMs) throw new Error('HTTP: not online');
      await delay(120);
    }
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

    const res = await this.post(url, body, this.opts.webhook?.token, this.opts.webhook?.timeoutMs);
    const parsed = safeParse(res) as Message | null;
    if (!parsed) return;

    if (parsed.action === Actions.OutboxStreamAck && parsed.payload) {
      const ack = parsed.payload as OutboxStreamAckPayload;
      if (this.pendingAck) this.pendingAck.resolve(ack);
      else this.lastAckBuffer = ack;
    }
  }

  /**
   * Await the next OutboxStreamAck. If an ACK already arrived earlier,
   * it's returned immediately (buffered).
   */
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
          // Always ping pingUrl; never fall back to webhook.url
          const pingUrl = this.opts.webhook!.pingUrl!; // validated in constructor
          const raw = await this.post(
            pingUrl,
            JSON.stringify(ping),
            this.opts.webhook?.token,
            this.opts.webhook?.timeoutMs
          );
          this.log.verbose('HTTP ping published');

          // Parse reply and mark online on valid Pong (with optional password match)
          const parsed = safeParse(raw) as Message | null;

          if (!parsed) {
            this.log.debug(`HTTP post non-JSON reply: ${raw?.slice(0, 200)}`);
            return;
          }

          if (parsed?.action === Actions.Pong) {
            const pw = (parsed.payload as any)?.password;
            const ok = this.opts.ping?.password ? pw === this.opts.ping.password : true;
            if (ok) {
              this.lastPongAt = Date.now();
              this.online = true;
              this.log.verbose('HTTP pong accepted (heartbeat)');
            }
          }
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

  // --- Low-level POST helper -------------------------------------------------
  private async post(urlStr: string, body: string, token?: string, timeoutMs = 2_000): Promise<string> {
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
          path: url.pathname,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          });
          res.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        }
      );
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
