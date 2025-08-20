import { EntitySchema } from 'typeorm';
import type { DomainEvent } from '@easylayer/common/cqrs';
import { EventStatus } from '@easylayer/common/cqrs';
import { CompressionUtils, CompressionMetrics } from './compression.utils';

type DriverType = 'sqlite' | 'postgres';

export interface EventDataParameters {
  type: string; // constructor.name
  payload: string; // JSON of user payload only
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
      {
        name: `IDX_${aggregateId}_status`,
        columns: ['status'],
      },
    ],
  });
};

// Row -> event instance (with top-level system fields)
export async function deserialize(
  aggregateId: string,
  { status, type, requestId, blockHeight, payload, isCompressed }: EventDataParameters,
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
    status,
  });

  return event;
}

// event instance -> row (always stored as UNPUBLISHED on insert)
export async function serialize(
  event: Record<string, any>,
  version: number,
  dbDriver: DriverType = 'postgres'
): Promise<EventDataParameters> {
  const { aggregateId, requestId, blockHeight, ...payload } = event;

  if (!requestId) {
    throw new Error('Request Id is missed in the event');
  }

  if (version == null) {
    throw new Error('Version is missing');
  }

  if (blockHeight == null) {
    throw new Error('blockHeight is missing in the event');
  }

  const type = Object.getPrototypeOf(event).constructor.name;

  const isSqlite = dbDriver === 'sqlite';
  let data = JSON.stringify(payload ?? {});
  let isCompressed = false;

  // Compress payload for PostgreSQL if beneficial
  if (!isSqlite && data.length > 1000 && CompressionUtils.shouldCompress(data)) {
    try {
      const res = await CompressionUtils.compress(data);
      data = res.data;
      isCompressed = true;
    } catch (error) {
      // Keep original JSON string
    }
  }

  return {
    status: EventStatus.UNPUBLISHED, // force status on write
    version,
    requestId: event.requestId,
    payload: data,
    blockHeight: event.blockHeight,
    type,
    isCompressed,
  };
}
