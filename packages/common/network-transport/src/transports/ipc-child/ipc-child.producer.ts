import type { ProducerConfig } from '../../core';
import { BaseProducer, utf8Len } from '../../core';
import type { AppLogger } from '@easylayer/common/logger';
import type { Envelope, OutboxStreamAckPayload, OutboxStreamBatchPayload, WireEventRecord } from '../../shared';
import { Actions, TRANSPORT_OVERHEAD_WIRE } from '../../shared';

type Defer<T> = { p: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Defer<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * IPC child producer:
 * - Strict correlationId for OutboxStream ACK and RPC.
 * - Maintains pending map keyed by correlationId.
 * Memory: pending map per in-flight request; serialized string per send.
 */
export class IpcChildProducer extends BaseProducer {
  private readonly pending = new Map<string, Defer<any>>();

  constructor(log: AppLogger, cfg: ProducerConfig) {
    super(log, cfg);

    process.on('message', (raw: any) => {
      if (typeof raw !== 'string') return;
      let msg: Envelope<any>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.action === Actions.Pong) {
        this.onPong(Date.now());
        return;
      }

      // Strict ACK by correlationId for outbox
      if (msg.action === Actions.OutboxStreamAck && msg.correlationId) {
        const d = this.pending.get(msg.correlationId);
        if (d) {
          this.pending.delete(msg.correlationId);
          d.resolve(msg.payload);
        }
        return;
      }

      // RPC response by correlationId
      if (msg.action === Actions.RpcResponse && msg.correlationId) {
        const d = this.pending.get(msg.correlationId);
        if (d) {
          this.pending.delete(msg.correlationId);
          d.resolve(msg.payload);
        }
        return;
      }
    });

    this.startRetryTimerIfNeeded();
  }

  protected _isUnderlyingConnected(): boolean {
    return !!process?.send;
  }

  protected async _sendSerialized(serialized: string): Promise<void> {
    if (!process.send) throw new Error('[ipc-child] IPC channel is not available');
    process.send(serialized);
  }

  /** Strict IPC outbox flow: send with correlationId and await exact OutboxStreamAck back. */
  public async sendOutboxBatchAndWaitAckIPC(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    const correlationId = uuid();
    const env: Envelope<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      payload: { events },
      timestamp: Date.now(),
      correlationId,
    };

    // Size check here because we bypass generic waitForAck/sendMessage
    const serialized = JSON.stringify(env); // TODO(perf): see BaseProducer comment re: payload re-escaping
    const byteLen = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (byteLen > this['cfg'].maxMessageBytes) {
      throw new Error(`[ipc-child] message too large: ${byteLen} > ${this['cfg'].maxMessageBytes}`);
    }
    if (!(await this.isConnected())) {
      throw new Error('[ipc-child] not connected');
    }

    const d = defer<OutboxStreamAckPayload>();
    this.pending.set(correlationId, d);

    const to = setTimeout(() => {
      if (this.pending.delete(correlationId)) d.reject(new Error('[ipc-child] ACK timeout'));
    }, this['cfg'].ackTimeoutMs);

    try {
      await this._sendSerialized(serialized);
      return await d.p;
    } finally {
      clearTimeout(to);
      this.pending.delete(correlationId);
    }
  }

  /** RPC request with correlationId */
  public async request<TReq = unknown, TRes = unknown>(route: string, data?: TReq): Promise<TRes> {
    const correlationId = uuid();
    const env: Envelope = {
      action: Actions.RpcRequest,
      correlationId,
      payload: { route, data },
      timestamp: Date.now(),
    };

    const serialized = JSON.stringify(env);
    const byteLen = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (byteLen > this['cfg'].maxMessageBytes) {
      throw new Error(`[ipc-child] message too large: ${byteLen} > ${this['cfg'].maxMessageBytes}`);
    }
    if (!(await this.isConnected())) {
      throw new Error('[ipc-child] not connected');
    }

    const d = defer<TRes>();
    this.pending.set(correlationId, d);

    const to = setTimeout(() => {
      if (this.pending.delete(correlationId)) d.reject(new Error(`[ipc-child] RPC timeout for ${route}`));
    }, this['cfg'].ackTimeoutMs);

    try {
      await this._sendSerialized(serialized);
      return await d.p;
    } finally {
      clearTimeout(to);
      this.pending.delete(correlationId);
    }
  }
}
