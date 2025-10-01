import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { Message, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';
import type { TransportPort } from '../../../core/transport-port';

export interface HttpBrowserClientOptions {
  type: 'http';
  webhook: { url: string; pingUrl?: string; token?: string; timeoutMs?: number; password?: string };
  ping?: { staleMs?: number; factor?: number; minMs?: number; maxMs?: number };
}

/**
 * Browser HTTP client:
 * - Sends batch/ping via fetch to webhook.
 * - Accepts Pong/Ack responses in HTTP body.
 */
@Injectable()
export class HttpBrowserService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'http' as const;

  private readonly log = new Logger(HttpBrowserService.name);
  private online = false;
  private lastPongAt = 0;

  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: { resolve: (v: OutboxStreamAckPayload) => void; reject: (e: any) => void; timer: any } | null =
    null;

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  constructor(private readonly opts: HttpBrowserClientOptions) {
    if (!this.opts.webhook?.url) throw new Error('http-browser: webhook.url is required');
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
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
      if (Date.now() - start >= deadlineMs) throw new Error('browser-http: not online');
      await delay(120);
    }
  }

  async send(msg: Message | string): Promise<void> {
    const url = this.opts.webhook.url;
    const body = typeof msg === 'string' ? msg : JSON.stringify(msg);

    const resTxt = await this.post(url, body, this.opts.webhook.token, this.opts.webhook.timeoutMs);
    const parsed = safeParse(resTxt) as Message | null;
    if (!parsed) return;

    if (parsed.action === Actions.Pong) {
      const pw = (parsed.payload as any)?.password;
      const ok = this.opts.webhook.password ? pw === this.opts.webhook.password : true;
      if (ok) {
        this.lastPongAt = Date.now();
        this.online = true;
        this.log.verbose('browser-http pong accepted');
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
        reject(new Error('browser-http: ACK timeout'));
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

        const ping: Message = { action: Actions.Ping, timestamp: Date.now() }; // no password in ping
        try {
          await this.post(
            this.opts.webhook.pingUrl ?? this.opts.webhook.url,
            JSON.stringify(ping),
            this.opts.webhook.token,
            this.opts.webhook.timeoutMs
          );
          this.log.verbose('browser-http ping published');
        } catch (e: any) {
          this.log.debug(`browser-http ping error: ${e?.message ?? e}`);
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

  private async post(url: string, body: string, token?: string, timeoutMs = 2000): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-transport-token': token } : {}) },
        body,
        signal: ctrl.signal,
      });
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
