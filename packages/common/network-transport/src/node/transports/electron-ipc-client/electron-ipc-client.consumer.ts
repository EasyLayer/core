// Electron MAIN (Node) CLIENT as CONSUMER.
// - Listens for streams from renderer (OutboxStreamBatch) and replies with OutboxStreamAck.
// - Can initiate QueryRequest to renderer and await QueryResponse.
// - Heartbeat (Ping/Pong) supported.
// Requires: preload to expose ipcRenderer in renderer and both sides using channel 'transport:message'.

import type { WebContents, IpcMainEvent } from 'electron';
import { ipcMain } from 'electron';
import { BaseConsumer, Actions } from '../../../core';
import type {
  Envelope,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  QueryResponsePayload,
  QueryRequestPayload,
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

export type ElectronIpcClientOptions = {
  wc: WebContents;
  ackAll?: boolean; // if true, ACK all indices by default
  ackIndices?: (events: OutboxStreamBatchPayload['events']) => number[]; // custom ACK selection
  queryTimeoutMs?: number;
};

export class ElectronIpcClientConsumer extends BaseConsumer {
  private readonly wc: WebContents;
  private readonly queryWaiters = new Map<string, Defer<any>>();

  constructor(private readonly opts: ElectronIpcClientOptions) {
    super();
    this.wc = opts.wc;

    this.onIpcMessage = this.onIpcMessage.bind(this);
    ipcMain.on('transport:message', this.onIpcMessage);
  }

  public destroy(): void {
    ipcMain.off('transport:message', this.onIpcMessage);
    this.queryWaiters.forEach((w) => w.reject(new Error('destroyed')));
    this.queryWaiters.clear();
  }

  private onIpcMessage(event: IpcMainEvent, raw: unknown) {
    // accept only from the bound renderer window
    if (!event?.sender || event.sender.id !== this.wc.id) return;
    const msg: Envelope<any> = typeof raw === 'string' ? JSON.parse(raw as string) : (raw as any);
    this.onMessage(msg).catch(() => {});
  }

  protected async handleBusinessMessage(message: Envelope): Promise<void> {
    // Handle Outbox stream batch -> send ACK back
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

    // Route QueryResponse to pending waiter
    if (message.action === Actions.QueryResponse) {
      const reqId = message.requestId || message.correlationId || '';
      const waiter = this.queryWaiters.get(reqId);
      if (waiter) {
        this.queryWaiters.delete(reqId);
        waiter.resolve((message.payload || {}) as QueryResponsePayload);
      }
      return;
    }
  }

  protected async _send(message: Envelope): Promise<void> {
    if (this.wc.isDestroyed()) throw new Error('webContents destroyed');
    this.wc.send('transport:message', JSON.stringify(message));
  }

  /** Renderer answers PONG; we just call BaseConsumer.handlePong -> no-op by default */
  protected async handlePong(_message: Envelope): Promise<void> {
    return;
  }

  /** Optional convenience: initiate QueryRequest toward renderer and await QueryResponse */
  public async query<T = any>(name: string, dto?: any, timeoutMs = this.opts.queryTimeoutMs ?? 5000): Promise<T> {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const waiter = defer<QueryResponsePayload>();
    this.queryWaiters.set(requestId, waiter);

    const req: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      requestId,
      correlationId: requestId,
      payload: { name, dto },
      timestamp: Date.now(),
    };
    await this._send(req);

    const timer = setTimeout(() => {
      if (this.queryWaiters.delete(requestId)) waiter.reject(new Error('Query timeout'));
    }, timeoutMs);

    try {
      const resp = await waiter.p;
      if (resp.err) throw new Error(resp.err);
      return resp.data as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
