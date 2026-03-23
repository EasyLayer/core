import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { QueryBus } from '@easylayer/common/cqrs';
import type { Message, TransportPort, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';
import { buildQuery } from '../../build-query';

export interface SharedWorkerServerOptions {
  type: 'shared-worker-server';
  /** Optional password — client must send matching pongPassword to be considered online. */
  pongPassword?: string;
  timeouts?: { ackMs?: number; pingStaleMs?: number };
}

/**
 * SharedWorkerServerService
 * -------------------------
 * Browser-side transport that runs inside a SharedWorker.
 *
 * Mirrors ElectronIpcMainService but uses MessagePorts from self.onconnect
 * instead of Electron ipcMain. Handles:
 *   - ping → pong  (liveness check from windows)
 *   - query.request → QueryBus → query.response
 *   - outbox.stream.batch → fan-out to all connected windows
 *
 * Worker.ts only needs:
 *   (self as any).__ENV = { TRANSPORT_OUTBOX_KIND: 'shared-worker-server', ... };
 *   await bootstrapBrowser({ Models, QueryHandlers });
 *   // ← service is auto-registered, onconnect is wired, everything works
 */
@Injectable()
export class SharedWorkerServerService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'shared-worker-server' as const;

  private readonly ports = new Set<MessagePort>();
  private online = false; // true once at least one window connected and ponged
  private lastPongAt = 0;

  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: {
    resolve: (v: OutboxStreamAckPayload) => void;
    reject: (e: any) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private heartbeatController: { destroy: () => void } | null = null;

  constructor(
    private readonly opts: SharedWorkerServerOptions,
    private readonly queryBus: QueryBus
  ) {
    // Wire SharedWorker onconnect — drain any ports that connected
    // before this service was instantiated (queued by worker.ts bootstrap shim).
    const pending: MessagePort[] = (self as any).__pendingSharedWorkerPorts ?? [];
    for (const port of pending) this.addPort(port);
    (self as any).__pendingSharedWorkerPorts = null;

    // Take over onconnect for all future connections
    (self as any).onconnect = (e: MessageEvent) => this.addPort(e.ports[0]!);

    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    (self as any).onconnect = null;
    for (const port of this.ports) port.close();
    this.ports.clear();
  }

  // ── TransportPort interface ───────────────────────────────────────────────

  isOnline(): boolean {
    const stale = this.opts.timeouts?.pingStaleMs ?? 15_000;
    return this.online && Date.now() - this.lastPongAt < stale;
  }

  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!this.isOnline()) {
      if (Date.now() - start >= deadlineMs) throw new Error('SharedWorker: no client online');
      await delay(120);
    }
  }

  /** Broadcast a message to all connected windows. */
  async send(msg: Message): Promise<void> {
    const frame = JSON.stringify(msg);
    for (const port of this.ports) {
      try {
        port.postMessage(frame);
      } catch {
        this.ports.delete(port);
      }
    }
  }

  async waitForAck(deadlineMs = this.opts.timeouts?.ackMs ?? 2_000): Promise<OutboxStreamAckPayload> {
    if (this.lastAckBuffer) {
      const ack = this.lastAckBuffer;
      this.lastAckBuffer = null;
      return ack;
    }
    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error('SharedWorker: ACK timeout'));
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

  // ── Port management ───────────────────────────────────────────────────────

  addPort(port: MessagePort): void {
    this.ports.add(port);
    port.onmessage = (ev) => this.onRaw(port, ev.data);
    port.onmessageerror = () => this.ports.delete(port);
    port.start();
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    // Send periodic pings from server → client so client can track liveness
    this.heartbeatController = exponentialIntervalAsync(
      async () => {
        if (this.ports.size === 0) return;
        const ping: Message = { action: Actions.Ping, timestamp: Date.now() };
        await this.send(ping).catch(() => {});
      },
      { interval: 500, multiplier: 1.6, maxInterval: 5000 }
    );
  }

  private stopHeartbeat(): void {
    this.heartbeatController?.destroy?.();
    this.heartbeatController = null;
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private onRaw(port: MessagePort, raw: unknown): void {
    const msg = normalize(raw);
    if (!msg?.action) return;

    switch (msg.action) {
      case Actions.Pong: {
        const pw = (msg.payload as any)?.password;
        const ok = this.opts.pongPassword ? pw === this.opts.pongPassword : true;
        if (ok) {
          this.lastPongAt = Date.now();
          this.online = true;
        }
        return;
      }

      case Actions.OutboxStreamAck: {
        const ack = msg.payload as OutboxStreamAckPayload;
        if (this.pendingAck) this.pendingAck.resolve(ack);
        else this.lastAckBuffer = ack;
        return;
      }

      case Actions.QueryRequest: {
        void this.handleQuery(port, msg);
        return;
      }

      default:
        return;
    }
  }

  private async handleQuery(port: MessagePort, msg: Message): Promise<void> {
    const name = (msg.payload as any)?.name;
    const dto = (msg.payload as any)?.dto;
    if (typeof name !== 'string') return;

    try {
      const result = await this.queryBus.execute(buildQuery({ name, dto }));
      this.sendTo(port, {
        action: Actions.QueryResponse,
        requestId: msg.requestId,
        timestamp: Date.now(),
        payload: { ok: true, data: result },
      });
    } catch (e: any) {
      this.sendTo(port, {
        action: Actions.QueryResponse,
        requestId: msg.requestId,
        timestamp: Date.now(),
        payload: { ok: false, err: String(e?.message ?? e) },
      });
    }
  }

  /** Send to a single port (query responses). */
  private sendTo(port: MessagePort, msg: Message): void {
    try {
      port.postMessage(JSON.stringify(msg));
    } catch {
      this.ports.delete(port);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function normalize(raw: unknown): Message | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Message;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as Message;
  return null;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
