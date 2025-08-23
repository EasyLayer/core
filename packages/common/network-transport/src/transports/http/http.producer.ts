import type { AppLogger } from '@easylayer/common/logger';
import type { ProducerConfig } from '../../core';
import { BaseProducer, utf8Len } from '../../core';
import type { Envelope, OutboxStreamAckPayload, OutboxStreamBatchPayload, WireEventRecord } from '../../shared';
import { Actions, TRANSPORT_OVERHEAD_WIRE } from '../../shared';

/**
 * HTTP producer:
 * - For RPC or generic sendMessage: posts the serialized envelope and checks status.
 * - For outbox streaming: returns ACK from response body (no correlationId here).
 * Memory: one serialized string per request; complexity O(n) over payload size.
 */
/* eslint-disable no-empty */
async function httpPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers, body });
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}
/* eslint-enable no-empty */

export class HttpWebhookProducer extends BaseProducer {
  constructor(log: AppLogger, cfg: ProducerConfig & { endpoint: string }) {
    super(log, cfg);
  }

  protected _isUnderlyingConnected(): boolean {
    // Stateles HTTP: assume connectable; failures surface on request.
    return true;
  }

  protected async _sendSerialized(serialized: string): Promise<void> {
    const { status } = await httpPost(
      (this.cfg as any).endpoint,
      {
        'Content-Type': 'application/json',
        ...(this.cfg.token ? { 'X-Transport-Token': this.cfg.token } : {}),
      },
      serialized
    );

    if (status >= 400) throw new Error(`[http] response status ${status}`);
  }

  /** HTTP path for outbox streaming: ACK comes in response body. */
  public async sendOutboxBatchAndWaitAckHTTP(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    const env: Envelope<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      payload: { events },
      timestamp: Date.now(),
    };
    const serialized = JSON.stringify(env); // see BaseProducer TODO about payload re-escaping
    const byteLen = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (byteLen > this['cfg'].maxMessageBytes) {
      throw new Error(`[http] message too large: ${byteLen} > ${this['cfg'].maxMessageBytes}`);
    }

    const { status, json } = await httpPost(
      (this['cfg'] as any).endpoint,
      {
        'Content-Type': 'application/json',
        ...(this['cfg'].token ? { 'X-Transport-Token': this['cfg'].token } : {}),
        ...extractRequestIdsHeader(events),
      },
      serialized
    );

    if (status >= 400) throw new Error(`[http] response status ${status}`);
    if (!json || typeof json.allOk !== 'boolean') throw new Error('[http] invalid ACK payload');
    return json as OutboxStreamAckPayload;
  }
}

function extractRequestIdsHeader(events: WireEventRecord[]): Record<string, string> {
  try {
    const ids = events.map((e) => e.requestId).filter(Boolean);
    if (!ids.length) return {};
    return { 'X-Event-Request-Ids': ids.join(',') };
  } catch {
    return {};
  }
}
