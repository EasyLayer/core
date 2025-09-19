import { exponentialIntervalAsync } from '@easylayer/common/exponential-interval-async';
import type { Envelope } from './messages';
import { TRANSPORT_OVERHEAD_WIRE, Actions } from './messages';

export type ProducerConfig = {
  name: string;
  maxMessageBytes: number;
  ackTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  heartbeatBackoffMultiplier?: number;
  heartbeatMaxIntervalMs?: number;
};

type Defer<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function createDeferred<T>(): Defer<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function utf8Len(str: string): number {
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(str, 'utf8');
  }
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else if ((code & 0xfc00) === 0xd800 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      len += 4;
      i++;
    } else len += 3;
  }
  return len;
}

export abstract class BaseProducer {
  protected readonly configuration: ProducerConfig;

  private lastPongTime = 0;
  private heartbeatController: { destroy: () => void } | null = null;
  private heartbeatReset: (() => void) | null = null;

  private pendingAck: Defer<any> | null = null;

  protected constructor(configuration: ProducerConfig) {
    this.configuration = configuration;
  }

  protected abstract _sendRaw(serialized: string, byteLength: number, context?: unknown): Promise<void>;
  protected abstract _isUnderlyingConnected(): boolean;

  /* eslint-disable no-empty */
  public destroy(): void {
    this.stopHeartbeat();
    if (this.pendingAck) {
      try {
        this.pendingAck.reject(new Error(`[${this.configuration.name}] destroyed`));
      } catch {}
      this.pendingAck = null;
    }
  }
  /* eslint-enable no-empty */

  public isConnected(): boolean {
    if (!this._isUnderlyingConnected()) return false;
    if (this.lastPongTime === 0) return true;
    return Date.now() - this.lastPongTime < this.configuration.heartbeatTimeoutMs;
  }

  protected buildPingEnvelope(): Envelope<{ ts: number; nonce?: string; sid?: string }> {
    return {
      action: Actions.Ping,
      payload: { ts: Date.now() },
      timestamp: Date.now(),
    };
  }

  /* eslint-disable no-empty */
  public startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.configuration.heartbeatIntervalMs;
    const multiplier = this.configuration.heartbeatBackoffMultiplier ?? 2;
    const maxInterval = this.configuration.heartbeatMaxIntervalMs ?? this.configuration.heartbeatTimeoutMs;

    this.heartbeatController = exponentialIntervalAsync(
      async (reset) => {
        this.heartbeatReset = reset;
        if (!this._isUnderlyingConnected()) return;

        const ping = this.buildPingEnvelope();
        try {
          await this._sendSerialized(ping);
        } catch {}
      },
      { interval, multiplier, maxInterval }
    );
  }
  /* eslint-enable no-empty */

  public stopHeartbeat(): void {
    if (this.heartbeatController) {
      this.heartbeatController.destroy();
      this.heartbeatController = null;
      this.heartbeatReset = null;
    }
  }

  /* eslint-disable no-empty */
  public onPong(): void {
    this.lastPongTime = Date.now();
    if (this.heartbeatReset) {
      try {
        this.heartbeatReset();
      } catch {}
    }
  }
  /* eslint-enable no-empty */

  public serializeOnce(envelope: Envelope): { json: string; byteLength: number } {
    const json = JSON.stringify(envelope);
    const byteLength = utf8Len(json);
    return { json, byteLength };
  }

  protected async _sendSerialized(envelope: Envelope, context?: unknown): Promise<void> {
    const { json, byteLength } = this.serializeOnce(envelope);
    await this._sendRaw(json, byteLength, context);
  }

  public async sendMessage(envelope: Envelope, context?: unknown): Promise<void> {
    const { json, byteLength } = this.serializeOnce(envelope);
    if (byteLength + TRANSPORT_OVERHEAD_WIRE > this.configuration.maxMessageBytes) {
      throw new Error(
        `[${this.configuration.name}] envelope too large: ${byteLength}B (cap ${this.configuration.maxMessageBytes}B)`
      );
    }
    await this._sendRaw(json, byteLength, context);
  }

  public async waitForAck<T>(executor: () => Promise<void>): Promise<T> {
    if (this.pendingAck) {
      throw new Error(`[${this.configuration.name}] ack already pending`);
    }
    const deferred = createDeferred<T>();
    this.pendingAck = deferred as Defer<any>;
    let timeoutRef: any;
    try {
      timeoutRef = setTimeout(() => {
        if (this.pendingAck === deferred) {
          this.pendingAck.reject(new Error(`[${this.configuration.name}] ACK timeout`));
          this.pendingAck = null;
        }
      }, this.configuration.ackTimeoutMs);
      await executor();
      const result = await deferred.promise;
      return result as T;
    } finally {
      clearTimeout(timeoutRef);
      if (this.pendingAck === deferred) {
        this.pendingAck = null;
      }
    }
  }

  public resolveAck<T>(value: T): void {
    const d = this.pendingAck;
    if (!d) return;
    this.pendingAck = null;
    d.resolve(value);
  }

  public rejectAck(err: unknown): void {
    if (this.pendingAck) this.pendingAck.reject(err);
  }

  public async waitForOnline(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isConnected()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`[${this.configuration.name}] not online after ${timeoutMs}ms`);
  }
}
