import { EntitySchema } from 'typeorm';
import type { DriverType } from './adapters';

export interface OutboxRowInternal {
  id: number; // bigserial/integer autoincrement
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

export const createOutboxEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<OutboxRowInternal> => {
  const isPostgres = dbDriver === 'postgres';

  // Auto-incrementing sequence for guaranteed order
  const id: any = {
    type: isPostgres ? 'bigserial' : 'integer',
    primary: true,
    generated: isPostgres ? true : 'increment',
  };

  // TypeORM column type for binary
  const binaryType = isPostgres ? 'bytea' : 'blob';
  const bytesType = isPostgres ? 'bigint' : 'integer';

  return new EntitySchema<OutboxRowInternal>({
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
      },
      blockHeight: {
        type: 'int',
      },
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
    uniques: [
      {
        name: 'UQ_outbox_aggregate_version',
        columns: ['aggregateId', 'eventVersion'],
      },
    ],
    indices: [
      { name: 'IDX_outbox_ts_id', columns: ['timestamp', 'id'] },
      // { name: 'IDX_outbox_agg_block', columns: ['aggregateId', 'blockHeight'] },
    ],
  });
};
