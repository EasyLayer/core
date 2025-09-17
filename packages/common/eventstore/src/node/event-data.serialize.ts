import type { DomainEvent } from '@easylayer/common/cqrs';
import type { DriverType, EventDataParameters } from '../core';
import { CompressionUtils } from './compression';
import { byteLengthUtf8, utf8ToBuffer, bufferToUtf8 } from './bytes';

/**
 * Single-pass serialization; ONE buffer feeds BOTH:
 *  - aggregate tables (BLOB/bytea)
 *  - outbox (BLOB/bytea)
 * No extra plain-buffer if compression is used.
 */
export async function serializeEventRow(
  event: DomainEvent,
  version: number,
  dbDriver: DriverType = 'postgres'
): Promise<EventDataParameters & { payloadUncompressedBytes: number }> {
  const { requestId, blockHeight, timestamp, payload } = event;

  if (!requestId) throw new Error('Request Id is missed in the event');
  if (version == null) throw new Error('Version is missing');
  if (blockHeight == null) throw new Error('blockHeight is missing in the event');
  if (!timestamp) throw new Error('timestamp is missing in the event');

  // -1 => null
  const normalizedHeight = blockHeight < 0 ? null : blockHeight;

  const type = Object.getPrototypeOf(event).constructor.name;
  const json = JSON.stringify(payload ?? {}); // string once
  const uncompressedLen = byteLengthUtf8(json); // exact uncompressed size
  const tryCompress = dbDriver === 'postgres' && CompressionUtils.shouldCompress(json);

  let buf: Buffer;
  let isCompressed = false;

  if (tryCompress) {
    const res = await CompressionUtils.compressToBuffer(json); // compressed Buffer
    if (res.compressedSize / res.originalSize < 0.9) {
      buf = res.buffer;
      isCompressed = true;
    } else {
      buf = utf8ToBuffer(json);
    }
  } else {
    buf = utf8ToBuffer(json);
  }

  return {
    type,
    payload: buf,
    version,
    requestId,
    blockHeight: normalizedHeight as any,
    isCompressed,
    timestamp,
    payloadUncompressedBytes: uncompressedLen,
  };
}

/** Read-side helper (OK to parse). Aggregate row uses Buffer payload. */
export async function deserializeToDomainEvent(
  aggregateId: string,
  { type, requestId, blockHeight, payload, isCompressed, version, timestamp }: EventDataParameters,
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
