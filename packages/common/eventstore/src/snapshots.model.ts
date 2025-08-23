import { EntitySchema } from 'typeorm';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { CompressionUtils } from './compression';
import type { DriverType } from './adapters';

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

/**
 * Deserialize snapshot DB row into in-memory object with parsed payload.
 * - Decompress if needed (PG case)
 * - Parse JSON and return clean SnapshotParameters (no compression flags)
 */
export async function deserializeSnapshot(
  row: SnapshotInterface,
  _dbDriver: DriverType = 'postgres'
): Promise<SnapshotParameters> {
  // NOTE: We always store Buffer. If compressed => inflate to string, else => utf8 string
  const jsonStr = row.isCompressed
    ? await CompressionUtils.decompressBufferToString(row.payload)
    : row.payload.toString('utf8');

  const payloadObj = JSON.parse(jsonStr);

  return {
    aggregateId: row.aggregateId,
    blockHeight: row.blockHeight,
    version: row.version,
    payload: payloadObj,
  };
}

/**
 * Serialize aggregate state into a snapshot row:
 * - aggregate.toSnapshot() MUST return a JSON string.
 * - For Postgres: compress if it’s beneficial; store compressed bytes in payload (bytea), set isCompressed=true.
 * - For SQLite: store plain UTF-8 bytes (blob), isCompressed=false (to keep CPU low on SQLite).
 *
 * The caller inserts the returned object into "snapshots" with TypeORM.
 */
export async function serializeSnapshot<T extends AggregateRoot<DomainEvent>>(
  aggregate: T,
  dbDriver: DriverType = 'postgres'
): Promise<Omit<SnapshotInterface, 'id' | 'createdAt'>> {
  const { aggregateId, lastBlockHeight, version } = aggregate;
  if (!aggregateId) throw new Error('aggregate Id is missed');
  if (lastBlockHeight == null) throw new Error('lastBlockHeight is missing');
  if (version == null) throw new Error('version is missing');

  const json = aggregate.toSnapshot(); // JSON string
  const isSqlite = dbDriver === 'sqlite';

  // start with plain utf8 bytes (ONE buffer)
  let payloadBuf = Buffer.from(json, 'utf8');
  let isCompressed = false;

  if (!isSqlite && CompressionUtils.shouldCompress(json)) {
    try {
      const comp = await CompressionUtils.compressToBuffer(json); // <- object with .buffer/.compressedSize
      // keep compression only if it really saves space (~10%+)
      if (comp.compressedSize < payloadBuf.length * 0.9) {
        payloadBuf = comp.buffer; // use compressed bytes
        isCompressed = true;
      }
    } catch {
      // keep plain
    }
  }

  return {
    aggregateId,
    blockHeight: lastBlockHeight,
    version,
    payload: payloadBuf,
    isCompressed,
  };
}
