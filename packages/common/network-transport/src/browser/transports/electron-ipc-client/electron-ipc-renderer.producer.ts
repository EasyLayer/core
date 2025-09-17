// Renderer/Browser PRODUCER over Electron IPC (renderer -> main).
// - Sends OutboxStreamBatch; receives OutboxStreamAck.
// - May receive Pong.
// - Not a query responder; it may initiate QueryRequest toward main if needed via manual call.

import { BaseProducer } from '../../../core';
import type { Envelope, OutboxStreamAckPayload } from '../../../core';
import { Actions } from '../../../core';

export type ElectronIpcRendererProducerOptions = {
  maxMessageBytes?: number;
  ackTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};

export class ElectronIpcRendererProducer extends BaseProducer {
  private ipc: { send: (ch: string, p: any) => void; on: (ch: string, cb: any) => void } | null = null;

  constructor(opts: ElectronIpcRendererProducerOptions = {}) {
    super({
      name: 'ipc',
      maxMessageBytes: opts.maxMessageBytes ?? 1024 * 1024,
      ackTimeoutMs: opts.ackTimeoutMs ?? 5000,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 800,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 8000,
    });

    const w = globalThis as any;
    this.ipc = w?.electron?.ipcRenderer ?? null;
    if (!this.ipc) throw new Error('ipcRenderer not available; expose via preload');

    this.ipc.on('transport:message', (_: any, raw: any) => {
      try {
        const env: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!env) return;
        if (env.action === Actions.Pong) this.onPong();
        if (env.action === Actions.OutboxStreamAck) this.resolveAck((env.payload || {}) as OutboxStreamAckPayload);
      } catch {
        /* ignore */
      }
    });
  }

  protected _isUnderlyingConnected(): boolean {
    return !!this.ipc;
  }
  protected async _sendRaw(serialized: string): Promise<void> {
    this.ipc!.send('transport:message', serialized);
  }
}
