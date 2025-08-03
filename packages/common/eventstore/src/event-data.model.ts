import { EntitySchema } from 'typeorm';
import type { HistoryEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { EventStatus } from '@easylayer/common/cqrs';
import { CompressionUtils, CompressionMetrics } from './compression.utils';

type DriverType = 'sqlite' | 'postgres';

export interface EventDataParameters {
  type: string;
  payload: Record<string, any> | string; // string for compressed payloads in PostgreSQL
  version: number;
  requestId: string;
  status: EventStatus;
  blockHeight: number;
  isCompressed?: boolean; // Flag to indicate if payload is compressed
}

export const createEventDataEntity = (
  aggregateId: string,
  dbDriver: DriverType = 'sqlite'
): EntitySchema<EventDataParameters> => {
  const isSqlite = dbDriver === 'sqlite';

  const statusColumn: any = {
    enum: EventStatus,
    default: EventStatus.UNPUBLISHED,
  };

  if (isSqlite) {
    statusColumn.type = 'simple-enum';
  } else {
    statusColumn.type = 'enum';
    statusColumn.enumName = 'event_status_enum';
  }

  const payloadColumn: any = {
    // type: isSqlite ? 'json' : 'text', // Use text for PostgreSQL to store compressed data
    type: 'text',
  };

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
      status: statusColumn,
      type: {
        type: 'varchar',
      },
      payload: payloadColumn,
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
      {
        name: `IDX_${aggregateId}_status`,
        columns: ['status'],
      },
    ],
  });
};

export async function deserialize(
  aggregateId: string,
  { status, type, requestId, blockHeight, payload, isCompressed }: EventDataParameters,
  dbDriver: DriverType = 'postgres'
): Promise<HistoryEvent<BasicEvent<EventBasePayload>>> {
  const isSqlite = dbDriver === 'sqlite';
  let finalPayload: any = payload;

  if (typeof payload !== 'string') {
    throw new Error(`Expected payload to be string, got ${typeof payload} for event ${type}`);
  }

  if (!isSqlite && isCompressed) {
    try {
      const startTime = Date.now();
      finalPayload = await CompressionUtils.decompressAndParse(payload);
      CompressionMetrics.recordDecompression(Date.now() - startTime);
    } catch (error) {
      CompressionMetrics.recordError();
      // Fallback to JSON.parse
      finalPayload = JSON.parse(payload);
    }
  } else {
    finalPayload = JSON.parse(payload);
  }

  const aggregateEvent: BasicEvent<EventBasePayload> = {
    payload: {
      aggregateId,
      requestId,
      blockHeight,
      ...(finalPayload || {}),
    },
  };

  aggregateEvent.constructor = { name: type } as typeof Object.constructor;
  const event = Object.assign(Object.create(aggregateEvent), aggregateEvent);

  return {
    event,
    status,
  };
}

export async function serialize(
  event: Record<string, any>,
  version: number,
  dbDriver: DriverType = 'postgres'
): Promise<EventDataParameters> {
  const { payload } = event;
  const { aggregateId, requestId, blockHeight, ...rest } = payload;

  if (!requestId) {
    throw new Error('Request Id is missed in the event');
  }

  if (version == null) {
    throw new Error('Version is missing');
  }

  if (blockHeight == null) {
    throw new Error('blockHeight is missing in the event');
  }

  const isSqlite = dbDriver === 'sqlite';
  let finalPayload: string = JSON.stringify(rest);
  let isCompressed = false;

  // Compress payload for PostgreSQL if beneficial
  if (!isSqlite && rest && finalPayload.length > 1000) {
    if (CompressionUtils.shouldCompress(finalPayload)) {
      try {
        const startTime = Date.now();
        const result = await CompressionUtils.compress(finalPayload);
        finalPayload = result.data;
        isCompressed = true;

        CompressionMetrics.recordCompression(result, Date.now() - startTime);
      } catch (error) {
        CompressionMetrics.recordError();
        // Keep original JSON string
      }
    }
  }

  const eventDataModel: EventDataParameters = {
    status: EventStatus.UNPUBLISHED,
    version,
    requestId,
    payload: finalPayload,
    blockHeight,
    type: Object.getPrototypeOf(event).constructor.name,
    isCompressed,
  };

  return eventDataModel;
}
