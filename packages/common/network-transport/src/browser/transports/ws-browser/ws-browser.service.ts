import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { Message, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';
import type { TransportPort } from '../../../core/transport-port';

export interface WsBrowserClientOptions {
  type: 'ws';
  url: string; // ws:// or wss://
  password?: string; // optional; if absent, first valid pong binds
  ping?: { staleMs?: number; factor?: number; minMs?: number; maxMs?: number };
  protocols?: string | string[]; // optional subprotocols
}

/**
 * Browser WebSocket client:
 * - Connects to server, sends batch/ping.
 * - Accepts Pong/Ack messages from server.
 */
@Injectable()
export class WsBrowserTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ws' as const;

  private readonly log = new Logger(WsBrowserTransportService.name);

  private socket: WebSocket | null = null;
  private clientId: string | undefined;

  private online = false;
  private lastPongAt = 0;

  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: { resolve: (v: OutboxStreamAckPayload) => void; reject: (e: any) => void; timer: any } | null =
    null;

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  constructor(private readonly opts: WsBrowserClientOptions) {
    if (!opts.url) throw new Error('ws-browser: url is required');
    this.connect();
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  // ----- BATCH/PING SECTION -----
  isOnline(): boolean {
    const stale = this.opts.ping?.staleMs ?? 15_000;
    return (
      !!this.socket &&
      this.socket.readyState === this.socket.OPEN &&
      this.online &&
      Date.now() - this.lastPongAt < stale
    );
  }

  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!this.isOnline()) {
      this.heartbeatReset?.();
      if (this.isOnline()) break;
      if (Date.now() - start >= deadlineMs) throw new Error('browser-ws: not online');
      await delay(120);
    }
  }

  async send(msg: Message | string): Promise<void> {
    const s = this.socket;
    if (!s || s.readyState !== s.OPEN) throw new Error('browser-ws: no connection');
    const frame = typeof msg === 'string' ? msg : JSON.stringify(msg);
    s.send(frame);
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
        reject(new Error('browser-ws: ACK timeout'));
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

  private connect() {
    this.clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ws = new WebSocket(this.opts.url, this.opts.protocols);
    ws.addEventListener('message', (ev) => this.onRaw(ev.data));
    ws.addEventListener('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.online = false;
      }
    });
    ws.addEventListener('open', () => {
      /* connection established; wait for pong */
    });
    this.socket = ws;
  }

  private startHeartbeat() {
    const multiplier = this.opts.ping?.factor ?? 1.6;
    const interval = this.opts.ping?.minMs ?? 600;
    const maxInterval = this.opts.ping?.maxMs ?? 5000;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;
        const s = this.socket;
        if (!s || s.readyState !== s.OPEN) return;

        // ping carries no password
        const ping: Message = { action: Actions.Ping, clientId: this.clientId, timestamp: Date.now() };
        try {
          s.send(JSON.stringify(ping));
          this.log.verbose('browser-ws ping published');
        } catch (e: any) {
          this.log.debug(`browser-ws ping error: ${e?.message ?? e}`);
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

  private onRaw(raw: unknown) {
    const msg = this.normalize(raw);
    if (!msg) return;

    switch (msg.action) {
      case Actions.Pong: {
        const pw = (msg.payload as any)?.password;
        const ok = this.opts.password ? pw === this.opts.password : true;
        if (ok) {
          this.lastPongAt = Date.now();
          this.online = true;
          this.log.verbose('browser-ws pong accepted');
        }
        return;
      }
      case Actions.OutboxStreamAck: {
        const ack = msg.payload as any as OutboxStreamAckPayload;
        if (this.pendingAck) this.pendingAck.resolve(ack);
        else this.lastAckBuffer = ack;
        return;
      }
      default:
        return;
    }
  }

  private normalize(raw: unknown): Message | null {
    if (!raw) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Message;
      } catch {
        return null;
      }
    }
    if (raw instanceof Blob) {
      /* best-effort */ return null;
    }
    if (raw instanceof ArrayBuffer) {
      try {
        return JSON.parse(new TextDecoder().decode(raw)) as Message;
      } catch {
        return null;
      }
    }
    if (typeof raw === 'object') return raw as Message;
    return null;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
