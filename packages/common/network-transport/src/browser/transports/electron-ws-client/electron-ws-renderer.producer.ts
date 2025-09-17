// Renderer/Browser PRODUCER over WebSocket (Socket.IO).
// - Sends OutboxStreamBatch; receives OutboxStreamAck, Pong.

import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { BaseProducer, Actions } from '../../../core';
import type { Envelope, OutboxStreamAckPayload } from '../../../core';

export type ElectronWsRendererProducerOptions = {
  url: string;
  path?: string;
  maxMessageBytes?: number;
  ackTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};

export class ElectronWsRendererProducer extends BaseProducer {
  private socket: Socket;

  /* eslint-disable no-empty */
  constructor(private readonly opts: ElectronWsRendererProducerOptions) {
    super({
      name: 'ws',
      maxMessageBytes: opts.maxMessageBytes ?? 1024 * 1024,
      ackTimeoutMs: opts.ackTimeoutMs ?? 5000,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 1000,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 10000,
    });

    this.socket = io(opts.url, { path: opts.path, transports: ['websocket'] });
    this.socket.on('message', (raw: any) => {
      try {
        const env: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!env) return;
        if (env.action === Actions.Pong) this.onPong();
        if (env.action === Actions.OutboxStreamAck) this.resolveAck((env.payload || {}) as OutboxStreamAckPayload);
      } catch {}
    });
    this.socket.on('connect', () => this.onPong());
  }
  /* eslint-enable no-empty */

  protected _isUnderlyingConnected(): boolean {
    return this.socket.connected;
  }
  protected async _sendRaw(serialized: string): Promise<void> {
    if (!this.socket.connected) throw new Error('[ws-renderer] not connected');
    this.socket.emit('message', serialized);
  }
}
