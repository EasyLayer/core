import { EntitySchema } from 'typeorm';
import type { HistoryEvent, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { EventStatus } from '@easylayer/common/cqrs';

type DriverType = 'sqlite' | 'postgres';

export interface EventDataParameters {
  type: string;
  payload: Record<string, any>;
  version: number;
  requestId: string;
  status: EventStatus;
  blockHeight: number;
}

// const VersionTransformer: ValueTransformer = {
//   to(value: number | string): string {
//     return value.toString();
//   },
//   from(dbValue: string): number {
//     return parseInt(dbValue, 10);
//   },
// };

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
        type: 'json',
      },
      blockHeight: {
        type: 'int',
        default: 0,
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

export function deserialize(
  aggregateId: string,
  { status, type, requestId, blockHeight, payload }: EventDataParameters
): HistoryEvent<BasicEvent<EventBasePayload>> {
  const aggregateEvent: BasicEvent<EventBasePayload> = {
    payload: {
      aggregateId,
      requestId,
      blockHeight,
      ...payload,
    },
  };

  aggregateEvent.constructor = { name: type } as typeof Object.constructor;

  const event = Object.assign(Object.create(aggregateEvent), aggregateEvent);

  return {
    event,
    status,
  };
}

export function serialize(event: Record<string, any>, version: number): EventDataParameters {
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

  const eventDataModel: EventDataParameters = {
    status: EventStatus.UNPUBLISHED,
    version,
    requestId,
    payload: rest,
    blockHeight,
    type: Object.getPrototypeOf(event).constructor.name,
  };

  return eventDataModel;
}
