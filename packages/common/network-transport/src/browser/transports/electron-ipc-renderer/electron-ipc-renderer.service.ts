import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
// Dynamic import is intentional.
//
// 'electron' is a Node.js/Electron-only package that uses __dirname and other
// Node globals at module evaluation time. A static top-level import would cause
// Vite (and any other browser bundler) to bundle the entire electron package
// into the output file — crashing immediately in any non-Electron context
// (browser SharedWorker, web page, etc.) with:
//   ReferenceError: __dirname is not defined
//
// With a dynamic import, bundlers treat 'electron' as an external that is
// resolved at runtime. In a real Electron renderer the import resolves
// correctly. In a browser bundle the import statement is left as-is and
// never executes unless the code path is actually reached (which it isn't,
// because ElectronIpcRendererModule is only registered in Electron builds).
import type { IpcRenderer } from 'electron';
import type { Message, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';
import type { TransportPort } from '../../../core/transport-port';

export interface ElectronIpcRendererOptions {
  type: 'electron-ipc-renderer';
  timeouts?: { ackMs?: number; onlineMs?: number; pingStaleMs?: number };
  ping?: { factor?: number; minMs?: number; maxMs?: number; password?: string };
}

/**
 * Electron renderer side:
 * - Sends batch/ping via ipcRenderer.
 * - Accepts Pong/Ack from main.
 */
@Injectable()
export class ElectronIpcRendererService implements TransportPort, OnModuleDestroy {
  public readonly kind = 'electron-ipc-renderer' as const;

  private readonly log = new Logger(ElectronIpcRendererService.name);

  private online = false;
  private lastPongAt = 0;

  private lastAckBuffer: OutboxStreamAckPayload | null = null;
  private pendingAck: { resolve: (v: OutboxStreamAckPayload) => void; reject: (e: any) => void; timer: any } | null =
    null;

  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  private ipc: IpcRenderer | null = null;

  private readonly onIpcMessage = (_ev: any, raw: unknown) => this.onRaw(raw);

  constructor(private readonly opts: ElectronIpcRendererOptions) {
    this.init();
  }

  private async init() {
    const { ipcRenderer } = await import('electron');
    this.ipc = ipcRenderer;
    this.ipc.on('transport:message', this.onIpcMessage);
    this.startHeartbeat();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    this.ipc?.off('transport:message', this.onIpcMessage);
  }

  // ----- BATCH/PING SECTION -----
  isOnline(): boolean {
    const stale = this.opts.timeouts?.pingStaleMs ?? 15_000;
    return this.online && Date.now() - this.lastPongAt < stale;
  }

  async waitForOnline(deadlineMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!this.isOnline()) {
      this.heartbeatReset?.();
      if (this.isOnline()) break;
      if (Date.now() - start >= deadlineMs) throw new Error('ipc-renderer: not online');
      await delay(120);
    }
  }

  async send(msg: Message | string): Promise<void> {
    this.ipc?.send('transport:message', msg);
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
        reject(new Error('ipc-renderer: ACK timeout'));
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

        const ping: Message = {
          action: Actions.Ping,
          timestamp: Date.now(),
          correlationId: uuid(),
        };
        try {
          this.ipc?.send('transport:message', ping);
          this.log.verbose('IPC renderer ping sent', { module: 'network-transport' });
        } catch (e: any) {
          this.log.verbose('IPC renderer ping send failed', {
            module: 'network-transport',
            args: { action: 'heartbeat', error: e?.message ?? e },
          });
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
          this.log.verbose('IPC renderer pong accepted, peer online', { module: 'network-transport' });
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
    if (typeof raw === 'object') return raw as Message;
    return null;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function uuid(): string {
  const c: any = (globalThis as any).crypto || (globalThis as any).msCrypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  if (bytes[6] !== undefined) bytes[6] = (bytes[6] & 0x0f) | 0x40;
  if (bytes[8] !== undefined) bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const toHex = (n: number) => (n + 0x100).toString(16).slice(1);
  return bytes.length
    ? `${toHex(bytes[0]!)}${toHex(bytes[1]!)}${toHex(bytes[2]!)}${toHex(bytes[3]!)}-${toHex(bytes[4]!)}${toHex(bytes[5]!)}-${toHex(bytes[6]!)}${toHex(bytes[7]!)}-${toHex(bytes[8]!)}${toHex(bytes[9]!)}-${toHex(bytes[10]!)}${toHex(bytes[11]!)}${toHex(bytes[12]!)}${toHex(bytes[13]!)}${toHex(bytes[14]!)}${toHex(bytes[15]!)}`
    : `${Math.random().toString(16).slice(2)}-${Date.now()}`;
}
