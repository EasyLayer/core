import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { QueryBus } from '@easylayer/common/cqrs';
import { Actions } from '../../../core';
import type { Message, TransportPort, OutboxStreamAckPayload } from '../../../core';

export interface IpcParentOptions {
  type: 'ipc-parent';
  child: ChildProcess;
  timeouts?: { ackMs?: number; onlineMs?: number; pingStaleMs?: number };
  ping?: { factor?: number; minMs?: number; maxMs?: number; password?: string }; // optional
}

@Injectable()
export class IpcParentTransportService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'ipc-parent' as const;
  private readonly log = new Logger(IpcParentTransportService.name);

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

  private readonly child: ChildProcess;
  private readonly onChildMessage = (msg: unknown) => this.onRaw(msg);

  constructor(
    private readonly opts: IpcParentOptions,
    private readonly queryBus: QueryBus
  ) {
    this.child = opts.child;

    this.child.on('message', this.onChildMessage);
    this.child.once('exit', () => {
      this.online = false;
    });

    this.startPingLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopPingLoop();
    this.child.off('message', this.onChildMessage);
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
      if (Date.now() - start >= deadlineMs) throw new Error('IPC parent: not online');
      await delay(100);
    }
  }

  async send(msg: Message | string): Promise<void> {
    if (!this.child || typeof this.child.send !== 'function')
      throw new Error('IPC parent: child.send is not available');
    this.child.send(msg as any);
    this.log.debug(`IPC parent send action=${typeof msg === 'string' ? '<string>' : (msg as Message).action}`);
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
        reject(new Error('IPC parent: ACK timeout'));
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

  private startPingLoop(): void {
    const multiplier = this.opts.ping?.factor ?? 1.6;
    const interval = this.opts.ping?.minMs ?? 400;
    const maxInterval = this.opts.ping?.maxMs ?? 4_000;

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
          this.child.send?.(ping as any);
          this.log.verbose('IPC parent ping published');
        } catch (e: any) {
          this.log.debug(`IPC parent ping error: ${e?.message ?? e}`);
        }
      },
      { interval, multiplier, maxInterval }
    );
  }

  private stopPingLoop(): void {
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
          this.log.verbose('IPC parent pong accepted');
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

  // ----- QUERY SECTION -----
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
      this.child.send?.(reply as any);
    } catch (e: any) {
      const reply: Message = {
        action: Actions.QueryResponse,
        payload: { ok: false, err: String(e?.message ?? e) },
        correlationId: msg.correlationId,
        timestamp: Date.now(),
      };
      this.child.send?.(reply as any);
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
