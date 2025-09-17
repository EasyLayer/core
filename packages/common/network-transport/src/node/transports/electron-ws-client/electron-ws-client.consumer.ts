// Electron MAIN/Node CLIENT over WebSocket (Socket.IO) as CONSUMER.
// - Connects to a WS server (e.g., renderer-hosted or external).
// - Listens for OutboxStreamBatch -> replies OutboxStreamAck.
// - Can initiate QueryRequest and await QueryResponse.

import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { BaseConsumer, Actions } from '../../../core';
import type {
  Envelope,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  QueryRequestPayload,
  QueryResponsePayload,
} from '../../../core';

type Defer<T> = { resolve: (v: T) => void; reject: (e: any) => void; p: Promise<T> };
function defer<T>(): Defer<T> {
  let r!: any, j!: any;
  const p = new Promise<T>((res, rej) => {
    r = res;
    j = rej;
  });
  return { resolve: r, reject: j, p };
}

export type ElectronWsClientOptions = {
  url: string;
  path?: string;
  ackAll?: boolean;
  ackIndices?: (events: OutboxStreamBatchPayload['events']) => number[];
  queryTimeoutMs?: number;
  extraHeaders?: Record<string, string>;
};

export class ElectronWsClientConsumer extends BaseConsumer {
  private socket: Socket;
  private readonly waiters = new Map<string, Defer<QueryResponsePayload>>();

  constructor(private readonly opts: ElectronWsClientOptions) {
    super();
    this.socket = io(opts.url, { path: opts.path, transports: ['websocket'], extraHeaders: opts.extraHeaders });
    this.socket.on('message', (raw: any) => {
      const msg: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw) : raw;
      this.onMessage(msg).catch(() => {});
    });
    this.socket.on('connect', () => {
      // optional: send Ping if needed
    });
  }

  protected async handleBusinessMessage(message: Envelope): Promise<void> {
    if (message.action === Actions.OutboxStreamBatch) {
      const payload = (message.payload || {}) as OutboxStreamBatchPayload;
      const indices = this.opts.ackIndices
        ? this.opts.ackIndices(payload.events)
        : this.opts.ackAll
          ? payload.events.map((_, i) => i)
          : [];
      const ack: Envelope<OutboxStreamAckPayload> = {
        action: Actions.OutboxStreamAck,
        payload: { allOk: indices.length === payload.events.length, okIndices: indices },
        correlationId: message.correlationId,
        requestId: message.requestId,
        timestamp: Date.now(),
      };
      await this._send(ack);
      return;
    }

    if (message.action === Actions.QueryResponse) {
      const id = message.requestId || message.correlationId || '';
      const w = this.waiters.get(id);
      if (w) {
        this.waiters.delete(id);
        w.resolve((message.payload || {}) as QueryResponsePayload);
      }
      return;
    }
  }

  protected async _send(message: Envelope): Promise<void> {
    this.socket.emit('message', JSON.stringify(message));
  }

  protected async handlePong(): Promise<void> {
    return;
  }

  public async query<T = any>(name: string, dto?: any, timeoutMs = this.opts.queryTimeoutMs ?? 5000): Promise<T> {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const w = defer<QueryResponsePayload>();
    this.waiters.set(id, w);

    const req: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      requestId: id,
      correlationId: id,
      payload: { name, dto },
      timestamp: Date.now(),
    };
    await this._send(req);

    const timer = setTimeout(() => {
      if (this.waiters.delete(id)) w.reject(new Error('Query timeout'));
    }, timeoutMs);

    try {
      const resp = await w.p;
      if (resp.err) throw new Error(resp.err);
      return resp.data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
