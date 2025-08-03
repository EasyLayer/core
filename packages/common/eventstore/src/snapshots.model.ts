import { EntitySchema } from 'typeorm';
import type { AggregateRoot, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { CompressionUtils, CompressionMetrics } from './compression.utils';

type DriverType = 'sqlite' | 'postgres';

export interface SnapshotParameters {
  aggregateId: string;
  blockHeight: number;
  version: number;
  payload: string | any; // string (compressed) or parsed object
  isCompressed?: boolean; // Flag to indicate if payload is compressed
}

export interface SnapshotInterface extends SnapshotParameters {
  id: string;
  createdAt: Date; // Add timestamp for better monitoring
}

export const createSnapshotsEntity = (dbDriver: DriverType = 'postgres'): EntitySchema<SnapshotInterface> => {
  const isSqlite = dbDriver === 'sqlite';

  // Different timestamp handling for different databases
  const createdAtColumn: any = {
    default: () => 'CURRENT_TIMESTAMP',
  };

  if (isSqlite) {
    createdAtColumn.type = 'datetime';
  } else {
    createdAtColumn.type = 'timestamp';
  }

  return new EntitySchema<SnapshotInterface>({
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
        type: 'text', // Use text to support both compressed and uncompressed payloads
      },
      isCompressed: {
        type: 'boolean',
        default: false,
        nullable: true,
      },
      createdAt: createdAtColumn,
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
      {
        name: 'IDX_created_at',
        columns: ['createdAt'],
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
};

export async function toSnapshot<T extends AggregateRoot<BasicEvent<EventBasePayload>>>(
  aggregate: T,
  dbDriver: DriverType = 'postgres'
): Promise<SnapshotParameters> {
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

  // Get JSON string from aggregate
  const payloadString = aggregate.toSnapshotPayload();
  const isSqlite = dbDriver === 'sqlite';
  let finalPayload: string = payloadString;
  let isCompressed = false;

  // Compress payload for PostgreSQL if beneficial
  if (!isSqlite && payloadString) {
    if (CompressionUtils.shouldCompress(payloadString)) {
      try {
        const startTime = Date.now();
        const result = await CompressionUtils.compress(payloadString);
        finalPayload = result.data;
        isCompressed = true;

        CompressionMetrics.recordCompression(result, Date.now() - startTime);
      } catch (error) {
        CompressionMetrics.recordError();
        // Keep original payload
      }
    }
  }

  const model: SnapshotParameters = {
    aggregateId,
    blockHeight: lastBlockHeight,
    version,
    payload: finalPayload,
    isCompressed,
  };

  return model;
}

export async function fromSnapshot(
  snapshotData: SnapshotParameters,
  dbDriver: DriverType = 'postgres'
): Promise<SnapshotParameters> {
  const isSqlite = dbDriver === 'sqlite';
  let finalPayload = snapshotData.payload;

  // Decompress payload if it was compressed and we're not using SQLite
  if (!isSqlite && snapshotData.isCompressed && typeof snapshotData.payload === 'string') {
    try {
      const startTime = Date.now();
      finalPayload = await CompressionUtils.decompressAndParse(snapshotData.payload);
      CompressionMetrics.recordDecompression(Date.now() - startTime);
    } catch (error) {
      CompressionMetrics.recordError();
      // Use original payload as fallback
    }
  }

  return {
    ...snapshotData,
    payload: finalPayload,
    isCompressed: false, // After decompression, it's no longer compressed
  };
}
