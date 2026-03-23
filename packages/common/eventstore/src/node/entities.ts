import { EntitySchema } from 'typeorm';
import type { DriverType } from '../core';
import type { EventDataModel } from '../core/event-data.model';
import type { SnapshotDataModel } from '../core/snapshots.model';
import type { OutboxDataModel } from '../core/outbox.model';

function safeName(raw: string): string {
  const s = raw.replace(/[^a-zA-Z0-9_]/g, '_');
  const hash = (Math.abs(hashCode(s)) % 999).toString();
  const base = s.slice(0, Math.max(0, 60 - hash.length - 1));
  return `${base}_${hash}`;
}
function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h;
}

export function getTableName(entity: any): string {
  return entity?.options?.tableName || entity?.options?.name || entity?.constructor?.name || String(entity);
}

export const createEventDataEntity = (
  aggregateId: string,
  dbDriver: DriverType = 'sqlite'
): EntitySchema<EventDataModel> => {
  const isPostgres = dbDriver === 'postgres';
  const id: any = { type: isPostgres ? 'bigint' : 'integer', primary: true, generated: 'increment' };
  const payload: any = { type: isPostgres ? 'bytea' : 'blob' };

  return new EntitySchema<EventDataModel>({
    name: aggregateId,
    tableName: aggregateId,
    columns: {
      id,
      version: { type: 'int', default: 0 },
      requestId: { type: 'varchar', nullable: false },
      type: { type: 'varchar' },
      payload,
      blockHeight: { type: 'int', nullable: true, default: null },
      isCompressed: { type: 'boolean', default: false, nullable: true },
      timestamp: { type: 'bigint' },
    },
    uniques: [{ name: safeName(`UQ_${aggregateId}_v_reqid`), columns: ['version', 'requestId'] }],
    indices: [{ name: safeName(`IDX_${aggregateId}_blockh`), columns: ['blockHeight'] }],
  });
};

export const createSnapshotsEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<SnapshotDataModel> => {
  const isPostgres = dbDriver === 'postgres';
  const id: any = { type: isPostgres ? 'bigint' : 'integer', primary: true, generated: 'increment' };
  const payload: any = { type: isPostgres ? 'bytea' : 'blob' };
  const createdAt: any = { type: isPostgres ? 'timestamp' : 'datetime', default: () => 'CURRENT_TIMESTAMP' };

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
    uniques: [{ name: 'UQ_aggregate_blockheight', columns: ['aggregateId', 'blockHeight'] }],
  });
};

export const createOutboxEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<OutboxDataModel> => {
  const isPostgres = dbDriver === 'postgres';
  const id: any = { type: isPostgres ? 'bigint' : 'integer', primary: true, generated: false };
  const binaryType = isPostgres ? 'bytea' : 'blob';
  const bytesType = isPostgres ? 'bigint' : 'integer';

  return new EntitySchema<OutboxDataModel>({
    name: 'outbox',
    tableName: 'outbox',
    columns: {
      id,
      aggregateId: { type: 'varchar' },
      eventType: { type: 'varchar' },
      eventVersion: { type: 'bigint' },
      requestId: { type: 'varchar', nullable: false },
      blockHeight: { type: 'int', nullable: true, default: null },
      payload: { type: binaryType as any },
      timestamp: { type: 'bigint' },
      isCompressed: { type: 'boolean', default: false, nullable: true },
      uncompressedBytes: { type: bytesType },
    },
    uniques: [{ name: 'UQ_outbox_aggregate_version', columns: ['aggregateId', 'eventVersion'] }],
    indices: [{ name: 'IDX_outbox_id', columns: ['id'] }],
  });
};
