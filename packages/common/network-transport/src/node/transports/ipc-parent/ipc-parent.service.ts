import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
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
function assertIpcParentBinding(child: ChildProcess) {
  const p: any = process;
  if (p && p.channel) throw new Error('IPC parent: running inside a child; use ipc-child transport here');
  if (!child || typeof child?.send !== 'function') throw new Error('IPC parent: child.send is not available');
  if ((child as any).channel == null)
    throw new Error('IPC parent: child has no IPC channel (stdio must include "ipc")');
}

export interface IpcParentOptions {
  type: 'ipc-parent';
  child: ChildProcess;
  /** Optional shared secret echoed in Pong to validate peer. */
  password?: string;
  timeouts?: {
    onlineMs?: number; // default 2000
    pingStaleMs?: number; // default 15000
    ackMs?: number; // default 2000
  };
  ping?: {
    intervalMs?: number; // default 800
    multiplier?: number; // default 1.6
    maxIntervalMs?: number; // default 4000
  };
}

/**
 * IPC transport bound to a PARENT process (single child peer).
 */
@Injectable()
export class IpcParentTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ipc-parent' as const;

  private readonly log = new Logger(IpcParentTransportService.name);

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

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  // exact handler ref to detach
  private childMessageHandler!: (raw: unknown) => void;

  constructor(
    private readonly opts: IpcParentOptions,
    private readonly queryBus: QueryBus
  ) {
    assertIpcParentBinding(opts.child);
    this.childMessageHandler = this.onChildMessage.bind(this);
    this.opts.child.on('message', this.childMessageHandler);
    this.opts.child.once('exit', () => {
      this.online = false;
      this.log.warn('IPC parent: child exited');
    });
    this.startHeartbeat();
  }

  /* eslint-disable no-empty */
  async onModuleDestroy(): Promise<void> {
    try {
      this.opts.child.off('message', this.childMessageHandler);
    } catch {}
    this.stopHeartbeat();
    if (this.pendingAck) {
      clearTimeout(this.pendingAck.timer);
      this.pendingAck.reject(new Error('IPC parent: transport destroyed'));
      this.pendingAck = null;
    }
  }
  /* eslint-enable no-empty */

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
      this.heartbeatReset?.();
      await delay(1000);
    }
    throw new Error(`${this.kind.toUpperCase()}: peer is offline (no valid Pong)`);
  }

  async send(msg: Message | string): Promise<void> {
    // Always ensure correlationId for object messages
    if (typeof msg === 'object') {
      if (!msg.correlationId) (msg as any).correlationId = randomUUID();

      // Track correlationId only for batches to pair with waitForAck()
      if (msg.action === Actions.OutboxStreamBatch) {
        this.currentBatchCorrelationId = (msg as any).correlationId!;
      }
    }

    try {
      this.opts.child.send?.(msg as any);
      if (typeof msg === 'object') {
        this.log.verbose(`ipc-parent -> ${msg.action} cid=${(msg as any).correlationId}`);
      } else {
        this.log.verbose('ipc-parent -> <string>');
      }
    } catch (e: any) {
      this.log.warn(`IPC parent send error: ${e?.message ?? e}`);
    }
  }

  async waitForAck(deadlineMs = this.opts.timeouts?.ackMs ?? 2_000): Promise<OutboxStreamAckPayload> {
    const id = this.currentBatchCorrelationId;
    if (!id) throw new Error('IPC parent: waitForAck called without a preceding batch send');

    if (this.ackBuffer && this.ackBuffer.id === id) {
      const out = this.ackBuffer.payload;
      this.ackBuffer = null;
      this.currentBatchCorrelationId = null;
      return out;
    }
    if (this.pendingAck) throw new Error('IPC parent: another ACK is pending');

    return new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingAck = null;
          this.currentBatchCorrelationId = null;
          reject(new Error('IPC parent: ack timeout'));
        },
        Math.max(1, deadlineMs)
      );
      this.pendingAck = { id, resolve, reject, timer };
    });
  }

  // --------------------------------------------------------------------------
  // Inbound (child -> parent)
  // --------------------------------------------------------------------------
  private async onChildMessage(raw: unknown): Promise<void> {
    const msg = normalize(raw);
    if (!msg) return;

    switch (msg.action) {
      case Actions.Ping: {
        // Not expected from child; still reply Pong defensively
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
        } else {
          this.log.warn('IPC parent: pong rejected (invalid password)');
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
  // Heartbeat (parent → child)
  // --------------------------------------------------------------------------
  private startHeartbeat(): void {
    const interval = Math.max(100, this.opts.ping?.intervalMs ?? 800);
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
