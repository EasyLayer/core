import { EntitySchema } from 'typeorm';
import type { AggregateRoot, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';

export interface SnapshotParameters {
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: string;
}

export interface SnapshotInterface extends SnapshotParameters {
  id: string;
}

export const createSnapshotsEntity = (): EntitySchema<SnapshotInterface> =>
  new EntitySchema<SnapshotInterface>({
    name: 'snapshots',
    tableName: 'snapshots',
    columns: {
      id: {
        type: 'varchar',
        primary: true,
        generated: 'uuid',
      },
      aggregateId: {
        type: 'varchar',
        // IMPORTANT: Removed primary: true to allow multiple snapshots per aggregate
      },
      blockHeight: {
        type: 'int',
        default: 0,
      },
      version: {
        type: 'int',
        default: 0,
      },
      payload: {
        type: 'text',
      },
    },
    indices: [
      {
        name: 'IDX_aggregate_blockheight',
        columns: ['aggregateId', 'blockHeight'],
      },
      {
        name: 'IDX_blockheight',
        columns: ['blockHeight'],
      },
    ],
    // IMPORTANT: Composite unique constraint to prevent duplicate snapshots
    uniques: [
      {
        name: 'UQ_aggregate_blockheight',
        columns: ['aggregateId', 'blockHeight'],
      },
    ],
  });

export function toSnapshot<T extends AggregateRoot<BasicEvent<EventBasePayload>>>(aggregate: T): SnapshotParameters {
  const { aggregateId, lastBlockHeight, version } = aggregate;

  if (!aggregateId) {
    throw new Error('aggregate Id is missed');
  }

  if (lastBlockHeight == null) {
    throw new Error('lastBlockHeight is missing');
  }

  if (version == null) {
    throw new Error('version is missing');
  }

  // Serialize the payload as a JSON string
  const payload = aggregate.toSnapshotPayload();

  const model: SnapshotParameters = {
    aggregateId,
    blockHeight: lastBlockHeight,
    version,
    payload,
  };

  return model;
}
