import { EntitySchema } from 'typeorm';
import type { DomainEvent } from '@easylayer/common/cqrs';
import { CompressionUtils, CompressionMetrics } from './compression.utils';

type DriverType = 'sqlite' | 'postgres';

export interface EventDataParameters {
  type: string; // constructor.name
  payload: string; // JSON string or base64(deflate(JSON)) for aggregate tables
  version: number;
  requestId: string;
  blockHeight: number;
  isCompressed?: boolean;
}

export const createEventDataEntity = (
  aggregateId: string,
  dbDriver: DriverType = 'sqlite'
): EntitySchema<EventDataParameters> => {
  return new EntitySchema<EventDataParameters>({
    name: aggregateId,
    tableName: aggregateId,
    columns: {
      version: {
        type: 'bigint',
        primary: true,
        default: 0,
      },
      requestId: {
        type: 'varchar',
        default: null,
      },
      type: {
        type: 'varchar',
      },
      payload: {
        type: 'text',
      },
      blockHeight: {
        type: 'int',
        default: 0,
      },
      isCompressed: {
        type: 'boolean',
        default: false,
        nullable: true,
      },
    },
    uniques: [
      {
        name: `UQ_${aggregateId}_v_reqid`,
        columns: ['version', 'requestId'],
      },
    ],
    indices: [
      {
        name: `IDX_${aggregateId}_blockh`,
        columns: ['blockHeight'],
      },
    ],
  });
};

/** Read-side helper (OK to parse). Not used on publish path. */
export async function deserializeToDomainEvent(
  aggregateId: string,
  { type, requestId, blockHeight, payload, isCompressed, version }: EventDataParameters,
  dbDriver: DriverType = 'postgres'
): Promise<DomainEvent> {
  const isSqlite = dbDriver === 'sqlite';
  let body: any;

  if (!isSqlite && isCompressed) {
    try {
      body = await CompressionUtils.decompressAndParse(payload);
    } catch (error) {
      CompressionMetrics.recordError();
      // Fallback to JSON.parse
      body = JSON.parse(payload);
    }
  } else {
    body = JSON.parse(payload);
  }

  const proto: any = { payload: body };
  proto.constructor = { name: type } as any;

  const event: DomainEvent = Object.assign(Object.create(proto), {
    aggregateId,
    requestId,
    blockHeight,
    version, // Include version from database
    timestamp: body.timestamp, // Extract timestamp from payload if needed
  });

  return event;
}

/**
 * Single-pass serialization; output is used for BOTH:
 *  - aggregate tables (TEXT payload, possibly base64(deflate))
 *  - outbox (binary Buffer + uncompressed byte length)
 */
export async function serializeEventRow(
  event: Record<string, any>,
  version: number,
  dbDriver: DriverType = 'postgres'
): Promise<
  EventDataParameters & {
    // additional fields used for outbox mapping (no duplication of logic)
    payloadUncompressedBytes: number;
    payloadForOutboxBuffer: Buffer; // binary for outbox (compressed or plain UTF-8)
  }
> {
  const { aggregateId, requestId, blockHeight, ...payload } = event;

  if (!requestId) throw new Error('Request Id is missed in the event');
  if (version == null) throw new Error('Version is missing');
  if (blockHeight == null) throw new Error('blockHeight is missing in the event');

  const type = Object.getPrototypeOf(event).constructor.name;
  const isSqlite = dbDriver === 'sqlite';

  // JSON once
  const json = JSON.stringify(payload ?? {});
  const uncompressedLen = Buffer.byteLength(json, 'utf8');

  let isCompressed = false;
  let aggregatePayloadText = json; // what goes to aggregate tables (TEXT)
  let outboxPayloadBuffer = Buffer.from(json, 'utf8'); // what goes to outbox (BLOB/BYTEA)

  if (!isSqlite && uncompressedLen > 2048 && CompressionUtils.shouldCompress(json)) {
    try {
      const t0 = Date.now();
      const res = await CompressionUtils.compress(json); // base64
      CompressionMetrics.recordCompression(res, Date.now() - t0);

      // Only keep compression if it actually saves space
      if (res.compressedSize / res.originalSize < 0.9) {
        isCompressed = true;
        aggregatePayloadText = res.data; // base64 string for TEXT column
        outboxPayloadBuffer = Buffer.from(res.data, 'base64'); // binary bytes for BYTEA/BLOB
      }
    } catch {
      // keep json plain
    }
  }

  return {
    type,
    payload: aggregatePayloadText,
    version,
    requestId,
    blockHeight,
    isCompressed,
    payloadUncompressedBytes: uncompressedLen,
    payloadForOutboxBuffer: outboxPayloadBuffer,
  };
}
