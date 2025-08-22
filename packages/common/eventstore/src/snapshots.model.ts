import { EntitySchema } from 'typeorm';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { CompressionUtils } from './compression.utils';

export type DriverType = 'sqlite' | 'postgres';

export interface SnapshotParameters {
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: string | any; // TEXT (possibly base64(deflate(JSON))) or plain object after deserialize
  isCompressed?: boolean;
}

export interface SnapshotInterface extends SnapshotParameters {
  id: string;
  createdAt: Date;
}

export const createSnapshotsEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<SnapshotInterface> => {
  const isSqlite = dbDriver === 'sqlite';
  const createdAtColumn: any = { type: isSqlite ? 'datetime' : 'timestamp', default: () => 'CURRENT_TIMESTAMP' };

  return new EntitySchema<SnapshotInterface>({
    name: 'snapshots',
    tableName: 'snapshots',
    columns: {
      id: { type: 'varchar', primary: true, generated: 'uuid' },
      aggregateId: { type: 'varchar' },
      blockHeight: { type: 'int', default: 0 },
      version: { type: 'int', default: 0 },
      payload: { type: 'text' },
      isCompressed: { type: 'boolean', default: false, nullable: true },
      createdAt: createdAtColumn,
    },
    indices: [
      { name: 'IDX_aggregate_blockheight', columns: ['aggregateId', 'blockHeight'] },
      { name: 'IDX_blockheight', columns: ['blockHeight'] },
      { name: 'IDX_created_at', columns: ['createdAt'] },
    ],
    // IMPORTANT: Composite unique constraint to prevent duplicate snapshots
    uniques: [
      {
        name: 'UQ_aggregate_blockheight',
        columns: ['aggregateId', 'blockHeight'],
      },
    ],
  });
};

export async function deserializeSnapshot(
  snapshotData: SnapshotParameters,
  dbDriver: DriverType = 'postgres'
): Promise<SnapshotParameters> {
  const isSqlite = dbDriver === 'sqlite';
  let finalPayload = snapshotData.payload;

  if (!isSqlite && snapshotData.isCompressed && typeof snapshotData.payload === 'string') {
    try {
      finalPayload = await CompressionUtils.decompressAndParse(snapshotData.payload);
    } catch {
      // fallback: leave as-is
    }
  }

  return { ...snapshotData, payload: finalPayload, isCompressed: false };
}

export async function serializeSnapshot<T extends AggregateRoot<DomainEvent>>(
  aggregate: T,
  dbDriver: DriverType = 'postgres'
): Promise<SnapshotParameters> {
  const { aggregateId, lastBlockHeight, version } = aggregate;
  if (!aggregateId) throw new Error('aggregate Id is missed');
  if (lastBlockHeight == null) throw new Error('lastBlockHeight is missing');
  if (version == null) throw new Error('version is missing');

  const payloadString = aggregate.toSnapshot();
  const isSqlite = dbDriver === 'sqlite';
  let finalPayload: string = payloadString;
  let isCompressed = false;

  if (!isSqlite && payloadString && CompressionUtils.shouldCompress(payloadString)) {
    try {
      const result = await CompressionUtils.compress(payloadString);
      finalPayload = result.data;
      isCompressed = true;
    } catch {
      /* keep plain */
    }
  }

  return { aggregateId, blockHeight: lastBlockHeight, version, payload: finalPayload, isCompressed };
}
