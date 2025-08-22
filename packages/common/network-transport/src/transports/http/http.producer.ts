import { Injectable, Inject } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { BaseProducer, BatchAckResult } from '../../core';
import {
  OutgoingMessage,
  MESSAGE_SIZE_LIMITS,
  validateMessageSize,
  ConnectionError,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
} from '../../shared';
import type { WireEventRecord } from '../../shared';

export interface HttpWebhookOptions {
  url: string;
  timeoutMs?: number;
  maxMessageSize?: number;
  headers?: Record<string, string>;
}

/**
 * HTTP Webhook Producer:
 * - No persistent connection or ping/pong (TLS handled by HTTPS).
 * - Outbox streaming uses **server→external webhook** POST with JSON payload {batchId, events}.
 * - ACK is parsed from HTTP response JSON ({allOk|okIndices|okKeys}).
 * - isConnected() returns true if URL configured; failures are signaled per-request via errors.
 */
@Injectable()
export class HttpWebhookProducer extends BaseProducer<OutgoingMessage> {
  private readonly maxMessageSize: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly log: AppLogger,
    @Inject('HTTP_WEBHOOK_OPTIONS') private readonly options: HttpWebhookOptions
  ) {
    super();
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.HTTP;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  isConnected(): boolean {
    return !!this.options.url;
  }
  markPong(): void {
    /* no-op for HTTP */
  }

  async sendMessage(_message: OutgoingMessage): Promise<void> {
    throw new Error('sendMessage() is not supported by HttpWebhookProducer (use sendOutboxStreamBatchWithAck)');
  }

  /**
   * Sends outbox batch to external webhook and interprets response as ACK.
   * Timeout → throws ConnectionError to trigger retry upstream.
   */
  async sendOutboxStreamBatchWithAck(
    events: WireEventRecord[],
    opts?: { timeoutMs?: number }
  ): Promise<BatchAckResult> {
    if (!this.isConnected()) throw new ConnectionError('HTTP webhook url is missing', { transportType: 'http' });

    const batchId = `http:${Date.now()}:${Math.random()}`;
    const payload: OutboxStreamBatchPayload = { batchId, events };
    validateMessageSize(payload, this.maxMessageSize, 'http');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(this.options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.options.headers || {}) },
        body: JSON.stringify(payload),
        signal: controller.signal,
      } as any);
    } catch (e) {
      clearTimeout(timer);
      throw new ConnectionError('HTTP webhook request failed', { transportType: 'http', cause: e as Error });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      throw new ConnectionError(`HTTP webhook responded with status ${resp.status}`, { transportType: 'http' });
    }

    // Response body MAY contain partial ACK info; if absent, treat as allOk.
    let ack: Partial<OutboxStreamAckPayload> = {};
    try {
      ack = await resp.json();
    } catch {
      /* assume allOk */
    }

    if (ack.allOk || (!ack.okIndices && !ack.okKeys)) return { allOk: true };

    const okIndices = new Set<number>();
    if (Array.isArray(ack.okIndices)) ack.okIndices.forEach((i) => typeof i === 'number' && okIndices.add(i));
    if (Array.isArray(ack.okKeys)) {
      const map = new Map<string, number[]>();
      events.forEach((e, idx) => {
        const key = `${e.modelName}#${e.eventVersion}`;
        const arr = map.get(key) || [];
        arr.push(idx);
        map.set(key, arr);
      });
      for (const k of ack.okKeys) {
        const key = `${k.modelName}#${k.eventVersion}`;
        (map.get(key) || []).forEach((i) => okIndices.add(i));
      }
    }

    return okIndices.size ? { allOk: false, okIndices: Array.from(okIndices).sort((a, b) => a - b) } : { allOk: true };
  }
}
