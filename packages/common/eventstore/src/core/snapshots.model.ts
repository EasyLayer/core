import { EntitySchema } from 'typeorm';
import type { DriverType } from './utils';

/**
 * Read-only lightweight snapshot for external services:
 * - payload: JSON string (no JSON.parse here)
 * - no DB `id` in the shape
 */
export interface SnapshotReadRow {
  modelId: string;
  blockHeight: number;
  version: number;
  payload: string; // JSON string; caller may JSON.parse if needed
}

/**
 * DB row shape: what is actually stored in the table.
 * payload is binary (bytea/blob). isCompressed says whether payload bytes are deflated JSON.
 */
export interface SnapshotDataModel {
  id?: string;
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: Buffer; // binary payload: deflated JSON or plain utf8 JSON bytes
  isCompressed?: boolean; // never null in practice
  createdAt: string;
}

export interface SnapshotParsedPayload extends SnapshotDataModel {
  payload: any; // parsed object
}

/** Create TypeORM entity for "snapshots" table (BLOB/bytea payload). */
export const createSnapshotsEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<SnapshotDataModel> => {
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

  return new EntitySchema<SnapshotDataModel>({
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
