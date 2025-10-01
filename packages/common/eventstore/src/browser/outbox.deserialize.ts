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
 * Convert an outbox DB row into a WireEventRecord.
 * - Decompresses if needed and returns payload as a JSON string (no JSON.parse).
 * - Normalizes blockHeight: DB NULL → -1 (wire/domain convention).
 */
export async function toWireEventRecord(row: OutboxRowForWire): Promise<WireEventRecord> {
  return {
    modelName: row.aggregateId,
    eventType: row.eventType,
    eventVersion: Number(row.eventVersion),
    requestId: row.requestId,
    blockHeight: row.blockHeight ?? -1,
    payload: bufferToUtf8(row.payload), // JSON string, NOT parsed
    timestamp: Number(row.timestamp),
  };
}
