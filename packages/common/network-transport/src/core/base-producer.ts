import type { AppLogger } from '@easylayer/common/logger';
import type { Envelope } from '../shared';
import { TRANSPORT_OVERHEAD_WIRE } from '../shared';

// Your exponential async timer (already exists in your codebase)
type ExpIntervalController = { destroy: () => void };
type ExpIntervalOpts = { interval: number; multiplier: number; maxInterval: number };
declare function exponentialIntervalAsync(
  tick: (reset: () => void) => Promise<void>,
  opts: ExpIntervalOpts
): ExpIntervalController;

export type ProducerConfig = {
  name: string;
  maxMessageBytes: number; // hard cap for serialized envelope bytes
  ackTimeoutMs: number; // e.g. 5000
  heartbeatMs: number; // base ping interval, e.g. 1000
  heartbeatTimeoutMs: number; // link is dead if no pong for this time, e.g. 8000
  token?: string;
};

type Defer<T> = { p: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Defer<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

export function utf8Len(str: string): number {
  // O(n) UTF-8 byte count (no allocations)
  let s = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    s += c < 0x80 ? 1 : c < 0x800 ? 2 : (c & 0xfc00) === 0xd800 ? 4 : 3;
  }
  return s;
}

export abstract class BaseProducer {
  protected readonly name: string;
  protected readonly log: AppLogger;
  protected readonly cfg: ProducerConfig;

  private lastPongTime = 0;
  private retryTimer: ExpIntervalController | null = null;

  protected constructor(log: AppLogger, cfg: ProducerConfig) {
    this.log = log;
    this.cfg = cfg;
    this.name = cfg.name;
  }

  // ── Connectivity / Heartbeat (exponential as you wanted) ────────────────────

  protected startRetryTimerIfNeeded(): void {
    if (this.retryTimer) return;
    this.retryTimer = exponentialIntervalAsync(
      async (reset) => {
        try {
          await this.sendPing().catch(() => {});
          if (await this.isConnected()) {
            reset(); // backoff reset on healthy state
          }
          await this.onHeartbeatTick().catch(() => {});
        } catch {
          /* keep retrying */
        }
      },
      { interval: this.cfg.heartbeatMs, multiplier: 2, maxInterval: this.cfg.heartbeatTimeoutMs }
    );
  }

  protected stopRetryTimer(): void {
    this.retryTimer?.destroy();
    this.retryTimer = null;
  }

  /** Called each heartbeat tick (override if producer needs periodic work). */
  protected async onHeartbeatTick(): Promise<void> {
    /* no-op */
  }

  public onPong(ts: number): void {
    this.lastPongTime = Date.now();
  }

  /**
   * Async connectivity check with a wait window.
   * Tries to become "connected" within `timeoutMs`. Returns true if link is healthy.
   * This is used by ProducersManager to implement the "connection timeout" semantics.
   */
  /* eslint-disable no-empty */
  public async isConnected(timeoutMs: number = 0): Promise<boolean> {
    if (this._isConnectedSync()) return true;
    if (timeoutMs <= 0) return false;

    const deadline = Date.now() + timeoutMs;
    // short polling + pings; complexity O(timeout/step)
    while (Date.now() < deadline) {
      try {
        await this.sendPing();
      } catch {}
      if (this._isConnectedSync()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this._isConnectedSync();
  }
  /* eslint-enable no-empty */

  private _isConnectedSync(): boolean {
    if (!this._isUnderlyingConnected()) return false;
    const age = Date.now() - this.lastPongTime;
    return age < this.cfg.heartbeatTimeoutMs;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Serialize the whole envelope once, measure its bytes, and send it.
   *
   * TODO(perf): this JSON.stringify will "re-escape" large event payload strings,
   *             adding ~10–15% CPU and some bytes due to escaping.
   *             To avoid it later, consider:
   *               1) a custom serializer that splices raw JSON payloads without re-escaping, or
   *               2) sending compressed binary payloads with a `contentEncoding` flag.
   *             For now we keep it simple and robust.
   */
  public async sendMessage<T = unknown>(message: Envelope<T>, target?: unknown): Promise<void> {
    const serialized = JSON.stringify(message);
    const byteLen = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;

    if (byteLen > this.cfg.maxMessageBytes) {
      throw new Error(`[${this.name}] message too large: ${byteLen} > ${this.cfg.maxMessageBytes} bytes`);
    }
    if (!(await this.isConnected())) {
      throw new Error(`[${this.name}] not connected`);
    }
    await this._sendSerialized(serialized, target);
  }

  public async waitForAck<T>(produce: () => Promise<void>, timeoutMs?: number): Promise<T> {
    const d = defer<T>();
    const to = setTimeout(() => d.reject(new Error(`[${this.name}] ACK timeout`)), timeoutMs ?? this.cfg.ackTimeoutMs);
    try {
      this._setPendingAck(d as Defer<any>);
      await produce();
      return await d.p;
    } finally {
      clearTimeout(to);
      this._clearPendingAck();
    }
  }

  public resolveAck<T>(value: T): void {
    this._resolvePendingAck(value);
  }
  public rejectAck(err: unknown): void {
    this._rejectPendingAck(err);
  }

  // ── Ping/Pong ───────────────────────────────────────────────────────────────

  public async sendPing(): Promise<void> {
    if (!this._isUnderlyingConnected()) return;
    const msg: Envelope = { action: 'ping', payload: { ts: Date.now() }, timestamp: Date.now() };
    const serialized = JSON.stringify(msg);
    await this._sendSerialized(serialized);
  }

  // ── Internals to implement by transports ───────────────────────────────────

  protected abstract _isUnderlyingConnected(): boolean;
  protected abstract _sendSerialized(serialized: string, target?: unknown): Promise<void>;

  // ── Pending ACK (single in-flight, non-correlated) ─────────────────────────

  private pendingAck: Defer<any> | null = null;
  private _setPendingAck(d: Defer<any>) {
    this.pendingAck = d;
  }
  private _clearPendingAck() {
    this.pendingAck = null;
  }
  private _resolvePendingAck(v: any) {
    this.pendingAck?.resolve(v);
  }
  private _rejectPendingAck(e: unknown) {
    this.pendingAck?.reject(e);
  }
}
