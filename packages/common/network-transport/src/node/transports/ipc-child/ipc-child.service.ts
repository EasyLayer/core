import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryBus } from '@easylayer/common/cqrs';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { TransportPort, Message, OutboxStreamAckPayload } from '../../../core';
import { Actions, buildQuery } from '../../../core';

// -- helpers ------------------------------------------------------------------
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
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
function assertIpcChildRuntime() {
  const p: any = process;
  if (!p || !p.channel || typeof p.send !== 'function' || p.connected !== true) {
    throw new Error('IPC child: no IPC channel. Fork the process with stdio including "ipc".');
  }
}

export interface IpcChildOptions {
  type: 'ipc-child';
  /** Optional shared secret echoed in Pong to validate peer. */
  password?: string;
  timeouts?: {
    onlineMs?: number; // default 2000
    pingStaleMs?: number; // default 15000
    ackMs?: number; // default 2000
  };
  ping?: {
    /** base interval; grows by multiplier until maxInterval */
    intervalMs?: number; // default 400
    multiplier?: number; // default 1.6
    maxIntervalMs?: number; // default 4000
  };
}

/**
 * IPC transport running inside a CHILD process (single peer: parent).
 */
@Injectable()
export class IpcChildTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ipc-child' as const;

  private readonly log = new Logger(IpcChildTransportService.name);
  private readonly onMessageBound = (raw: unknown) => this.onRaw(raw);

  private online = false;
  private lastPongAt = 0;

  private pendingAck: {
    id: string;
    resolve: (v: OutboxStreamAckPayload) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private ackBuffer: { id: string; payload: OutboxStreamAckPayload } | null = null;
  private currentBatchCorrelationId: string | null = null;

  // Heartbeat
  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  constructor(
    private readonly opts: IpcChildOptions,
    private readonly queryBus: QueryBus
  ) {
    assertIpcChildRuntime();
    (process as any).on('message', this.onMessageBound);
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    (process as any).off?.('message', this.onMessageBound);
    this.stopHeartbeat();
    if (this.pendingAck) {
      clearTimeout(this.pendingAck.timer);
      this.pendingAck.reject(new Error('IPC child: transport destroyed'));
      this.pendingAck = null;
    }
  }

  // --------------------------------------------------------------------------
  // TransportPort
  // --------------------------------------------------------------------------
  isOnline(): boolean {
    const stale = this.opts.timeouts?.pingStaleMs ?? 15_000;
    return this.online && Date.now() - this.lastPongAt < stale;
  }

  async waitForOnline(deadlineMs = this.opts.timeouts?.onlineMs ?? 2_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      if (this.isOnline()) return;
      // Nudge heartbeat to emit next Ping earlier
      this.heartbeatReset?.();
      await delay(1000);
    }
    throw new Error(`${this.kind.toUpperCase()}: peer is offline (no valid Pong)`);
  }

  async send(msg: Message | string): Promise<void> {
    const p: any = process;

    // Always ensure correlationId for any object message (Ping/Pong/Batch/QueryResponse/etc.)
    if (typeof msg === 'object') {
      if (!msg.correlationId) (msg as any).correlationId = randomUUID();

      // Track correlationId only for batches to pair with waitForAck()
      if (msg.action === Actions.OutboxStreamBatch) {
        this.currentBatchCorrelationId = (msg as any).correlationId!;
      }
    }

    try {
      p.send?.(msg as any);
      // unified logging for all messages
      if (typeof msg === 'object') {
        this.log.verbose(`ipc-child -> ${msg.action} cid=${(msg as any).correlationId}`);
      } else {
        this.log.verbose('ipc-child -> <string>');
      }
    } catch (e: any) {
      this.log.warn(`ipc-child send error: ${e?.message ?? e}`);
    }
  }

  async waitForAck(deadlineMs = this.opts.timeouts?.ackMs ?? 2_000): Promise<OutboxStreamAckPayload> {
    const id = this.currentBatchCorrelationId;
    if (!id) throw new Error('IPC child: waitForAck called without a preceding batch send');

    if (this.ackBuffer && this.ackBuffer.id === id) {
      const out = this.ackBuffer.payload;
      this.ackBuffer = null;
      this.currentBatchCorrelationId = null;
      return out;
    }
    if (this.pendingAck) throw new Error('IPC child: another ACK is pending');

    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingAck = null;
          this.currentBatchCorrelationId = null;
          reject(new Error('IPC child: ack timeout'));
        },
        Math.max(1, deadlineMs)
      );
      this.pendingAck = { id, resolve, reject, timer };
    });
  }

  // --------------------------------------------------------------------------
  // Inbound
  // --------------------------------------------------------------------------
  private async onRaw(raw: unknown): Promise<void> {
    const msg = normalize(raw);
    if (!msg) return;

    switch (msg.action) {
      case Actions.Ping: {
        // Echo correlationId + password in Pong
        await this.send({
          action: Actions.Pong,
          correlationId: msg.correlationId || randomUUID(),
          timestamp: Date.now(),
          payload: this.opts.password ? { password: this.opts.password } : undefined,
        });
        return;
      }

      case Actions.Pong: {
        const ok = this.opts.password ? (msg.payload as any)?.password === this.opts.password : true;
        if (ok) {
          this.lastPongAt = Date.now();
          this.online = true;
          this.log.verbose('IPC child: pong accepted');
        } else {
          this.log.warn('IPC child: pong rejected (invalid password)');
        }
        return;
      }

      case Actions.OutboxStreamAck: {
        const id = msg.correlationId;
        if (!id) return;
        const ack = (msg.payload ?? {}) as OutboxStreamAckPayload;
        if (this.pendingAck && this.pendingAck.id === id) {
          clearTimeout(this.pendingAck.timer);
          const { resolve } = this.pendingAck;
          this.pendingAck = null;
          this.currentBatchCorrelationId = null;
          resolve(ack);
        } else if (!this.pendingAck && this.currentBatchCorrelationId === id) {
          this.ackBuffer = { id, payload: ack };
        }
        return;
      }

      case Actions.QueryRequest: {
        const { name, dto } = (msg.payload as any) || {};
        await this.handleQuery(name, dto, msg.correlationId);
        return;
      }

      default:
        return;
    }
  }

  private async handleQuery(name: string, dto: any, cid?: string) {
    const base: Omit<Message, 'payload'> = {
      action: Actions.QueryResponse,
      timestamp: Date.now(),
      correlationId: cid || randomUUID(),
    } as any;

    try {
      if (!name || typeof name !== 'string') throw new Error('Invalid query payload');
      const data = await this.queryBus.execute(buildQuery({ name, dto }));
      const resp: Message = { ...base, payload: { ok: true, data } } as any;
      await this.send(resp);
    } catch (e: any) {
      const resp: Message = { ...base, payload: { ok: false, err: String(e?.message ?? e) } } as any;
      await this.send(resp);
    }
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------
  private startHeartbeat(): void {
    const interval = Math.max(100, this.opts.ping?.intervalMs ?? 400);
    const multiplier = Math.max(1.0, this.opts.ping?.multiplier ?? 1.6);
    const maxInterval = Math.max(interval, this.opts.ping?.maxIntervalMs ?? 4_000);

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;
        await this.send({
          action: Actions.Ping,
          correlationId: randomUUID(),
          timestamp: Date.now(),
        });
      },
      { interval, multiplier, maxInterval }
    );
  }

  private stopHeartbeat(): void {
    this.heartbeatController?.destroy?.();
    this.heartbeatController = null;
    this.heartbeatReset = null;
  }
}
