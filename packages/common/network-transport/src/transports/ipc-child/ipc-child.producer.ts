import { BaseProducer } from '../../core/base-producer';
import type { Envelope, OutboxStreamAckPayload } from '../../shared';
import { Actions } from '../../shared';
import { randomBytes, createHmac } from 'node:crypto';

export type IpcProducerConfig = {
  name: 'ipc';
  maxMessageBytes: number;
  ackTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  heartbeatBackoffMultiplier?: number;
  heartbeatMaxIntervalMs?: number;
  token?: string;
};

export class IpcChildProducer extends BaseProducer {
  private readonly token?: string;
  private readonly nonces: Map<string, number> = new Map(); // nonce -> ts

  constructor(cfg: IpcProducerConfig) {
    super({
      name: cfg.name,
      maxMessageBytes: cfg.maxMessageBytes,
      ackTimeoutMs: cfg.ackTimeoutMs,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs,
      heartbeatTimeoutMs: cfg.heartbeatTimeoutMs,
      heartbeatBackoffMultiplier: cfg.heartbeatBackoffMultiplier,
      heartbeatMaxIntervalMs: cfg.heartbeatMaxIntervalMs,
    });
    this.token = cfg.token;
    process.on('message', (m: any) => this.onProcessMessage(m));
  }

  protected _isUnderlyingConnected(): boolean {
    return !!process.connected && typeof process.send === 'function';
  }

  protected override buildPingEnvelope(): Envelope<{ ts: number; nonce?: string }> {
    const ts = Date.now();
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(nonce, ts);
    return { action: Actions.Ping, payload: { ts, nonce }, timestamp: ts };
  }

  public consumeNonce(nonce: string, maxAgeMs: number): boolean {
    const ts = this.nonces.get(nonce);
    if (typeof ts !== 'number') return false;
    this.nonces.delete(nonce);
    if (Date.now() - ts > maxAgeMs) return false;
    return true;
  }

  public verifyProof(nonce: string, ts: number, proof: string): boolean {
    if (!this.token) return false;
    const windowMs = Math.min(30000, (this as any).configuration.heartbeatTimeoutMs || 8000);
    if (!this.consumeNonce(nonce, windowMs)) return false;
    const expected = createHmac('sha256', this.token).update(`${nonce}|${ts}`).digest('hex');
    return expected === proof;
  }

  protected async _sendRaw(serialized: string): Promise<void> {
    if (process.send) process.send(serialized);
  }

  /* eslint-disable no-empty */
  private onProcessMessage(message: any): void {
    try {
      const envelope: Envelope<any> = typeof message === 'string' ? JSON.parse(message) : message;
      if (!envelope || typeof envelope !== 'object') return;

      if (envelope.action === Actions.Pong) {
        this.onPong();
        return;
      }
      if (envelope.action === Actions.OutboxStreamAck) {
        this.resolveAck((envelope.payload || {}) as OutboxStreamAckPayload);
        return;
      }
    } catch {}
  }
  /* eslint-enable no-empty */
}
