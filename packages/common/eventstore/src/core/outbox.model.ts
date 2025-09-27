import { EntitySchema } from 'typeorm';
import type { DriverType } from './utils';

export interface OutboxDataModel {
  id: string | number; // bigserial/integer
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number;
  payload: Buffer; // BLOB/bytea
  timestamp: number;
  isCompressed?: boolean;
  payload_uncompressed_bytes: number;
}

export const createOutboxEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<OutboxDataModel> => {
  const isPostgres = dbDriver === 'postgres';

  // IMPORTANT: primary key WITHOUT auto-generation
  const id: any = {
    type: isPostgres ? 'bigint' : 'integer', // sqlite/sqljs use INTEGER (rowid-capable)
    primary: true,
    generated: false,
  };

  // TypeORM column type for binary
  const binaryType = isPostgres ? 'bytea' : 'blob';
  const bytesType = isPostgres ? 'bigint' : 'integer';

  return new EntitySchema<OutboxDataModel>({
    name: 'outbox',
    tableName: 'outbox',
    columns: {
      id,
      aggregateId: {
        type: 'varchar',
      },
      eventType: {
        type: 'varchar',
      },
      eventVersion: {
        type: 'bigint',
      },
      requestId: {
        type: 'varchar',
        nullable: false,
      },
      blockHeight: { type: 'int', nullable: true, default: null },
      payload: { type: binaryType as any }, // binary
      timestamp: {
        type: 'bigint',
      },
      isCompressed: {
        type: 'boolean',
        default: false,
        nullable: true,
      },
      payload_uncompressed_bytes: { type: bytesType },
    },
    uniques: [{ name: 'UQ_outbox_aggregate_version', columns: ['aggregateId', 'eventVersion'] }],
    indices: [
      // With monotonic id we can order and range-scan by PRIMARY KEY only.
      { name: 'IDX_outbox_id', columns: ['id'] },

      // Keep a small helper index on timestamp if you still filter by time anywhere else.
      // { name: 'IDX_outbox_ts', columns: ['timestamp'] },
    ],
  });
};
