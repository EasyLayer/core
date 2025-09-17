import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import { bufferToUtf8 } from './bytes';

/** Minimal shape of the outbox row used for deserialization. */
export type OutboxRowForWire = {
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number | null;
  payload: Buffer;
  isCompressed: boolean | number;
  timestamp: number;
};

/**
 * Convert an outbox DB row into a WireEventRecord (browser).
 * Browser build: compression is disabled entirely — payload must be plain UTF-8.
 */
export async function deserializeToOutboxRaw(row: OutboxRowForWire): Promise<WireEventRecord> {
  if (row.isCompressed) {
    throw new Error('Compressed outbox payload is not supported in browser build');
  }

  const payloadString = bufferToUtf8(row.payload); // JSON string (NOT parsed)

  return {
    modelName: row.aggregateId,
    eventType: row.eventType,
    eventVersion: Number(row.eventVersion),
    requestId: row.requestId,
    blockHeight: row.blockHeight ?? -1, // DB NULL → -1
    payload: payloadString,
    timestamp: Number(row.timestamp),
  };
}
