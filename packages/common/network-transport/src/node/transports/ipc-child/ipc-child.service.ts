import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { QueryBus } from '@easylayer/common/cqrs';
import { Actions } from '../../../core';
import type { Message, TransportPort, OutboxStreamAckPayload } from '../../../core';

export interface IpcChildOptions {
  type: 'ipc-child';
  timeouts?: { ackMs?: number; onlineMs?: number; pingStaleMs?: number };
  ping?: { factor?: number; minMs?: number; maxMs?: number; password?: string }; // optional
}

/**
 * IPC child process.
 */
@Injectable()
export class IpcChildTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ipc-child' as const;

  private readonly log = new Logger(IpcChildTransportService.name);

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

  private onMessageBound = (msg: unknown) => this.onRaw(msg);

  constructor(
    private readonly opts: IpcChildOptions,
    private readonly queryBus: QueryBus
  ) {
    (process as any).on?.('message', this.onMessageBound);
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    (process as any).off?.('message', this.onMessageBound);
  }

  // ----- BATCH/PING SECTION -----
  isOnline(): boolean {
    const stale = this.opts.timeouts?.pingStaleMs ?? 15_000;
    return this.online && Date.now() - this.lastPongAt < stale;
  }

  async waitForOnline(deadlineMs = this.opts.timeouts?.onlineMs ?? 2_000): Promise<void> {
    const start = Date.now();
    while (!this.isOnline()) {
      this.heartbeatReset?.();
      if (this.isOnline()) break;
      if (Date.now() - start >= deadlineMs) throw new Error('IPC child: not online');
      await delay(100);
    }
  }

  async send(msg: Message | string): Promise<void> {
    if (!(process as any)?.send) throw new Error('IPC child: process.send is not available');
    const frame = typeof msg === 'string' ? msg : msg;
    (process as any).send(frame);
    this.log.debug(`IPC child send action=${typeof msg === 'string' ? '<string>' : (msg as Message).action}`);
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
        reject(new Error('IPC child: ACK timeout'));
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
    const interval = this.opts.ping?.minMs ?? 500;
    const maxInterval = this.opts.ping?.maxMs ?? 5000;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;

        // Ping does not include password.
        const ping: Message = {
          action: Actions.Ping,
          timestamp: Date.now(),
          correlationId: randomUUID(),
        };
        try {
          (process as any).send?.(ping);
          this.log.verbose('IPC child ping published');
        } catch (e: any) {
          this.log.debug(`IPC child ping error: ${e?.message ?? e}`);
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

  private onRaw(raw: unknown): void {
    const msg = this.normalize(raw);
    if (!msg) return;

    switch (msg.action) {
      case Actions.Pong: {
        const pw = (msg.payload as any)?.password;
        const ok = this.opts.ping?.password ? pw === this.opts.ping.password : true;
        if (ok) {
          this.lastPongAt = Date.now();
          this.online = true;
          this.log.verbose('IPC child pong accepted');
        }
        return;
      }
      case Actions.OutboxStreamAck: {
        const ack = msg.payload as any as OutboxStreamAckPayload;
        if (this.pendingAck) this.pendingAck.resolve(ack);
        else this.lastAckBuffer = ack;
        return;
      }
      // ----- QUERY SECTION -----
      case Actions.QueryRequest: {
        void this.handleQuery(msg);
        return;
      }
      default:
        return;
    }
  }

  private async handleQuery(msg: Message): Promise<void> {
    const name = (msg.payload as any)?.name;
    const data = (msg.payload as any)?.data;
    if (typeof name !== 'string') return;

    try {
      const query = { name, data } as any;
      const result = await this.queryBus.execute(query);
      const reply: Message = {
        action: Actions.QueryResponse,
        payload: { ok: true, data: result },
        correlationId: msg.correlationId,
        timestamp: Date.now(),
      };
      (process as any).send?.(reply);
    } catch (e: any) {
      const reply: Message = {
        action: Actions.QueryResponse,
        payload: { ok: false, err: String(e?.message ?? e) },
        correlationId: msg.correlationId,
        timestamp: Date.now(),
      };
      (process as any).send?.(reply);
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
    if (typeof raw === 'object') return raw as Message;
    return null;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
