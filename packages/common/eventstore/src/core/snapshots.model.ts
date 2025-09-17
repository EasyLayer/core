import { EntitySchema } from 'typeorm';
import type { DriverType } from './utils';

/**
 * DB row shape: what is actually stored in the table.
 * payload is binary (bytea/blob). isCompressed says whether payload bytes are deflated JSON.
 */
export interface SnapshotInterface {
  id: string;
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: Buffer; // binary payload: deflated JSON or plain utf8 JSON bytes
  isCompressed: boolean; // never null in practice
  createdAt: Date;
}

/**
 * In-memory shape after deserialize: what aggregate wants to consume.
 * payload is a parsed JS object.
 */
export interface SnapshotParameters {
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: any; // parsed object after decompress+parse
  isCompressed?: boolean; // always false after deserialize()
}

/** Create TypeORM entity for "snapshots" table (BLOB/bytea payload). */
export const createSnapshotsEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<SnapshotInterface> => {
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

  const createdAt: any = {
    type: isPostgres ? 'timestamp' : 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  };

  return new EntitySchema<SnapshotInterface>({
    name: 'snapshots',
    tableName: 'snapshots',
    columns: {
      id,
      aggregateId: { type: 'varchar' },
      blockHeight: { type: 'int', default: 0 },
      version: { type: 'int', default: 0 },
      payload,
      isCompressed: { type: 'boolean', default: false, nullable: true },
      createdAt,
    },
    indices: [
      { name: 'IDX_aggregate_blockheight', columns: ['aggregateId', 'blockHeight'] },
      { name: 'IDX_blockheight', columns: ['blockHeight'] },
      { name: 'IDX_created_at', columns: ['createdAt'] },
    ],
    uniques: [
      // prevent duplicate snapshot at the same chain height for the same aggregate
      { name: 'UQ_aggregate_blockheight', columns: ['aggregateId', 'blockHeight'] },
    ],
  });
};
