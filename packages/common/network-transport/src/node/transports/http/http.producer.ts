import { BaseProducer } from '../../../core';
import type { OutboxStreamAckPayload } from '../../../core';

export type HttpProducerConfig = {
  name: 'http';
  endpoint: string;
  maxMessageBytes: number;
  ackTimeoutMs: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  token?: string;
};

export class HttpProducer extends BaseProducer {
  private readonly endpoint: string;
  private readonly token?: string;

  constructor(cfg: HttpProducerConfig) {
    super({
      name: cfg.name,
      maxMessageBytes: cfg.maxMessageBytes,
      ackTimeoutMs: cfg.ackTimeoutMs,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs ?? 1000,
      heartbeatTimeoutMs: cfg.heartbeatTimeoutMs ?? cfg.ackTimeoutMs,
    });
    this.endpoint = cfg.endpoint;
    this.token = cfg.token;
  }

  public override startHeartbeat(): void {
    /* no-op */
  }

  protected _isUnderlyingConnected(): boolean {
    return true;
  }

  protected async _sendRaw(serialized: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['X-Transport-Token'] = this.token;

    const res = await fetch(this.endpoint, { method: 'POST', headers, body: serialized });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let ack: any = null;
    try {
      ack = await res.json();
    } catch {
      throw new Error('HTTP webhook did not return JSON ACK');
    }
    if (!ack || typeof ack.allOk !== 'boolean') {
      throw new Error('HTTP webhook returned invalid ACK');
    }
    this.resolveAck(ack as OutboxStreamAckPayload);
  }
}
