import { EntitySchema } from 'typeorm';
import type { DomainEvent } from '@easylayer/common/cqrs';
import { CompressionUtils } from './compression';
import type { DriverType } from './adapters';

/** Event row as stored in aggregate tables – payload is binary buffer now. */
export interface EventDataParameters {
  id?: number; // bigserial/integer autoincrement
  type: string;
  payload: Buffer; // BLOB/bytea for aggregate tables
  version: number;
  requestId: string;
  blockHeight: number;
  timestamp: number;
  isCompressed?: boolean;
}

/**
 * Aggregate event table schema generator (per-aggregate).
 * The payload column is BLOB/bytea, so both aggregates and outbox share the same bytes.
 */
export const createEventDataEntity = (
  aggregateId: string,
  dbDriver: DriverType = 'sqlite'
): EntitySchema<EventDataParameters> => {
  const isPostgres = dbDriver === 'postgres';

  // Auto-incrementing sequence for guaranteed order
  const id: any = {
    type: isPostgres ? 'bigserial' : 'integer',
    primary: true,
    generated: isPostgres ? true : 'increment',
  };

  const payload: any = {
    type: isPostgres ? 'bytea' : 'blob',
  };

  return new EntitySchema<EventDataParameters>({
    name: aggregateId,
    tableName: aggregateId,
    columns: {
      id,
      version: { type: 'int', default: 0 },
      requestId: { type: 'varchar', default: null },
      type: { type: 'varchar' },
      // Store binary payload; exact same bytes as we put to outbox:
      payload,
      blockHeight: { type: 'int', nullable: true, default: true },
      isCompressed: { type: 'boolean', default: false, nullable: true },
      timestamp: {
        type: 'bigint',
      },
    },
    uniques: [{ name: `UQ_${aggregateId}_v_reqid`, columns: ['version', 'requestId'] }],
    indices: [{ name: `IDX_${aggregateId}_blockh`, columns: ['blockHeight'] }],
  });
};

/**
 * Single-pass serialization; ONE buffer feeds BOTH:
 *  - aggregate tables (BLOB/bytea)
 *  - outbox (BLOB/bytea)
 * No extra plain-buffer if compression is used.
 */
export async function serializeEventRow(
  event: Record<string, any>,
  version: number,
  dbDriver: DriverType = 'postgres'
): Promise<
  EventDataParameters & {
    payloadUncompressedBytes: number;
  }
> {
  const { aggregateId, requestId, blockHeight, timestamp, payload } = event;

  if (!requestId) throw new Error('Request Id is missed in the event');
  if (version == null) throw new Error('Version is missing');
  if (blockHeight == null) throw new Error('blockHeight is missing in the event');

  // -1 => null
  const normalizedHeight = blockHeight < 0 ? null : blockHeight;

  const type = Object.getPrototypeOf(event).constructor.name;
  const json = JSON.stringify(payload ?? {}); // string once
  const uncompressedLen = Buffer.byteLength(json, 'utf8'); // exact uncompressed size
  const tryCompress = dbDriver === 'postgres' && CompressionUtils.shouldCompress(json);

  let buf: Buffer;
  let isCompressed = false;

  if (tryCompress) {
    const res = await CompressionUtils.compressToBuffer(json); // produces compressed Buffer
    // keep compression only if it saves at least ~10%
    if (res.compressedSize / res.originalSize < 0.9) {
      buf = res.buffer; // compressed bytes
      isCompressed = true;
    } else {
      buf = Buffer.from(json, 'utf8'); // fallback to plain bytes
    }
  } else {
    buf = Buffer.from(json, 'utf8'); // plain bytes (one buffer only)
  }

  return {
    type,
    payload: buf,
    version,
    requestId,
    blockHeight: normalizedHeight,
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
): Promise<DomainEvent> {
  const jsonStr = isCompressed ? await CompressionUtils.decompressBufferToString(payload) : payload.toString('utf8');
  const userPayload = JSON.parse(jsonStr);

  const proto: any = {};
  Object.defineProperty(proto, 'constructor', {
    value: { name: type },
    enumerable: false,
    configurable: true,
    writable: false,
  });

  const event: DomainEvent = Object.assign(Object.create(proto), {
    aggregateId,
    requestId,
    blockHeight: blockHeight ?? -1, // null => -1
    timestamp,
    payload: userPayload,
  });

  return event;
}
