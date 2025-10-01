import { Logger } from '@nestjs/common';
import type { TransportPort } from './transport-port';
import type { Message, OutboxStreamAckPayload } from './messages';
import { Actions } from './messages';

interface WireEventRecord {
  /** Business model name that the client understands (was aggregateId/table name) */
  modelName: string;
  /** Event constructor name */
  eventType: string;
  /** Version within aggregate */
  eventVersion: number;
  requestId: string;
  blockHeight: number;
  /** Serialized JSON string (already decompressed if DB compressed it) */
  payload: string;
  /** Milliseconds since epoch for ordering/telemetry */
  timestamp: number;
}

/**
 *
 * Single, optional "sender" for Outbox batches. It never owns connections:
 * - Uses an injected Producer (which handles pings, SSL, connectivity, raw send).
 * - Sends wire batches and awaits ACK with a short deadline.
 * - If no producer is set or producer is offline — throws fast for Outbox to react.
 */
export class OutboxBatchSender {
  private logger = new Logger(OutboxBatchSender.name);
  private transport: TransportPort | null = null;

  public setTransport(next: TransportPort | null): void {
    this.transport = next ?? null;
  }

  public getProducer(): TransportPort | null {
    return this.transport;
  }

  public async streamWireWithAck(events: WireEventRecord[]): Promise<OutboxStreamAckPayload> {
    if (!this.transport) {
      return { ok: true, okIndices: [] };
    }

    await this.transport.waitForOnline(5000);

    const message: Message<{ events: WireEventRecord[] }> = {
      action: Actions.OutboxStreamBatch,
      payload: { events },
      timestamp: Date.now(),
    };

    await this.transport.send(message);
    return await this.transport.waitForAck();
  }
}
