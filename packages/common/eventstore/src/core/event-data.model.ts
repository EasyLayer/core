import { EntitySchema } from 'typeorm';
import type { DriverType } from './utils';

/**
 * Read-only lightweight row for external services:
 * - modelId: aggregateId (table name) that produced this row (not stored in table)
 * - payload: JSON string (no JSON.parse here)
 */
export interface EventReadRow {
  modelId: string; // <- aggregateId (table name)
  eventType: string; // <- type
  eventVersion: number; // <- version
  requestId: string;
  blockHeight: number;
  payload: string; // JSON string; caller may JSON.parse if needed
  timestamp: number;
}

/** Event row as stored in aggregate tables – payload is binary buffer now. */
export interface EventDataModel {
  id?: number; // bigserial/integer autoincrement
  type: string;
  payload: Buffer; // BLOB/bytea for aggregate tables
  version: number;
  requestId: string;
  blockHeight: number;
  timestamp: number;
  isCompressed?: boolean;
}

/**
 * Aggregate event table schema generator (per-aggregate).
 * The payload column is BLOB/bytea, so both aggregates and outbox share the same bytes.
 */
export const createEventDataEntity = (
  aggregateId: string,
  dbDriver: DriverType = 'sqlite'
): EntitySchema<EventDataModel> => {
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

  return new EntitySchema<EventDataModel>({
    name: aggregateId,
    tableName: aggregateId,
    columns: {
      id,
      version: { type: 'int', default: 0 },
      requestId: { type: 'varchar', nullable: false },
      type: { type: 'varchar' },
      // Store binary payload; exact same bytes as we put to outbox:
      payload,
      blockHeight: { type: 'int', nullable: true, default: null },
      isCompressed: { type: 'boolean', default: false, nullable: true },
      timestamp: {
        type: 'bigint',
      },
    },
    uniques: [{ name: `UQ_${aggregateId}_v_reqid`, columns: ['version', 'requestId'] }],
    indices: [{ name: `IDX_${aggregateId}_blockh`, columns: ['blockHeight'] }],
  });
};
