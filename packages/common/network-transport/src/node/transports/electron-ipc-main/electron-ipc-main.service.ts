import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import { ipcMain, webContents as WC, WebContents } from 'electron';
import { QueryBus } from '@easylayer/common/cqrs';
import type { Message, TransportPort, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';

export interface ElectronIpcMainOptions {
  type: 'electron-ipc-main';
  timeouts?: { ackMs?: number; onlineMs?: number; pingStaleMs?: number };
  ping?: { factor?: number; minMs?: number; maxMs?: number; password?: string }; // optional
}

/**
 * Electron main side service.
 */
@Injectable()
export class ElectronIpcMainService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'electron-ipc-main' as const;

  private readonly log = new Logger(ElectronIpcMainService.name);

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

  private wc: WebContents | null = null;

  private readonly onIpcMessage = (_event: Electron.IpcMainEvent, raw: unknown) => this.onRaw(raw);

  constructor(
    private readonly opts: ElectronIpcMainOptions,
    private readonly queryBus: QueryBus
  ) {
    ipcMain.on('transport:message', this.onIpcMessage);
    const all = WC.getAllWebContents?.() ?? [];
    this.wc = all[0] ?? null;

    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    ipcMain.off('transport:message', this.onIpcMessage);
  }

  public setWebContents(wc: WebContents | null) {
    this.wc = wc;
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
      if (Date.now() - start >= deadlineMs) throw new Error('Electron main: not online');
      await delay(120);
    }
  }

  async send(msg: Message | string): Promise<void> {
    if (!this.wc) throw new Error('Electron main: no active WebContents');
    const payload = typeof msg === 'string' ? msg : msg;
    this.wc.send('transport:message', payload);
    this.log.debug(`Electron main send action=${typeof msg === 'string' ? '<string>' : (msg as Message).action}`);
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
        reject(new Error('Electron main: ACK timeout'));
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
        if (!this.wc) return;

        // Ping does not include password.
        const ping: Message = {
          action: Actions.Ping,
          timestamp: Date.now(),
          correlationId: randomUUID(),
        };
        try {
          this.wc.send('transport:message', ping);
          this.log.verbose('Electron main ping published');
        } catch (e: any) {
          this.log.debug(`Electron main ping error: ${e?.message ?? e}`);
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
        const ok = this.opts.ping?.password ? pw === this.opts.ping.password : true;
        if (ok) {
          this.lastPongAt = Date.now();
          this.online = true;
          this.log.verbose('Electron main pong accepted');
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
      await this.send(reply);
    } catch (e: any) {
      const reply: Message = {
        action: Actions.QueryResponse,
        payload: { ok: false, err: String(e?.message ?? e) },
        correlationId: msg.correlationId,
        timestamp: Date.now(),
      };
      await this.send(reply);
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
