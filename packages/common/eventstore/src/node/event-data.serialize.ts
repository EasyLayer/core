import type { DomainEvent } from '@easylayer/common/cqrs';
import type { DriverType, EventDataModel, EventReadRow } from '../core';
import { CompressionUtils } from './compression';
import { utf8ToBuffer, bufferToUtf8 } from './bytes';

/**
 * Single-pass serialization; ONE buffer feeds BOTH:
 *  - aggregate tables (BLOB/bytea)
 *  - outbox (BLOB/bytea)
 * No extra plain-buffer if compression is used.
 */
export async function toEventDataModel(
  event: DomainEvent,
  version: number,
  dbDriver: DriverType = 'postgres'
): Promise<EventDataModel> {
  const { requestId, blockHeight, timestamp, payload } = event;

  if (!requestId) throw new Error('Request Id is missed in the event');
  if (version == null) throw new Error('Version is missing');
  if (blockHeight == null) throw new Error('blockHeight is missing in the event');
  if (!timestamp) throw new Error('timestamp is missing in the event');

  // -1 => null
  const normalizedHeight = blockHeight < 0 ? null : blockHeight;

  const type = Object.getPrototypeOf(event).constructor.name;
  const json = JSON.stringify(payload ?? {}); // string once

  if (dbDriver === 'postgres' && CompressionUtils.shouldCompress(json)) {
    const deflated = await CompressionUtils.compressToBuffer(json);
    return {
      version,
      requestId,
      type,
      payload: deflated.buffer,
      isCompressed: true,
      blockHeight: normalizedHeight as any,
      timestamp,
    };
  }

  const buf = utf8ToBuffer(json);
  return {
    version,
    requestId,
    type,
    payload: buf,
    isCompressed: false,
    blockHeight: normalizedHeight as any,
    timestamp,
  };
}

// Builds a DomainEvent for aggregate rehydration.
// - Decompress/UTF-8 decode BLOB payload.
// - JSON.parse to get the event payload object.
// - Intended ONLY for domain path: model.loadFromHistory([...]).
export async function toDomainEvent(
  aggregateId: string,
  { type, requestId, blockHeight, payload, isCompressed, version, timestamp }: EventDataModel,
  _dbDriver: DriverType = 'postgres'
) {
  const jsonStr = isCompressed ? await CompressionUtils.decompressBufferToString(payload) : bufferToUtf8(payload);
  const userPayload = JSON.parse(jsonStr);

  const proto: any = {};
  Object.defineProperty(proto, 'constructor', {
    value: { name: type },
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return Object.assign(Object.create(proto), {
    aggregateId,
    requestId,
    blockHeight: blockHeight ?? -1, // null => -1
    timestamp,
    payload: userPayload,
  }) as DomainEvent;
}

// Converts a raw DB event row (BLOB payload) into a network-facing DTO.
// IMPORTANT:
// - payload is returned as a JSON STRING (already decompressed/decoded).
// - Never JSON.parse here; the caller decides when to parse.
// - This keeps read-path cheap for transport and avoids double parse.
export async function toEventReadRow(
  aggregateId: string,
  row: EventDataModel,
  _dbDriver: DriverType = 'postgres'
): Promise<EventReadRow> {
  const jsonStr = row.isCompressed
    ? await CompressionUtils.decompressBufferToString(row.payload)
    : bufferToUtf8(row.payload);

  return {
    modelId: aggregateId,
    eventType: row.type,
    eventVersion: row.version,
    requestId: row.requestId,
    blockHeight: row.blockHeight ?? -1,
    payload: jsonStr,
    timestamp: row.timestamp,
  };
}
