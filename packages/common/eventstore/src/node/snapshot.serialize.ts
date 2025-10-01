import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import type { DriverType, SnapshotDataModel, SnapshotReadRow, SnapshotParsedPayload } from '../core';
import { CompressionUtils } from './compression';
import { utf8ToBuffer, bufferToUtf8 } from './bytes';

export async function toSnapshotParsedPayload(
  row: SnapshotDataModel,
  _dbDriver: DriverType = 'postgres'
): Promise<SnapshotParsedPayload> {
  const jsonStr = row.isCompressed
    ? await CompressionUtils.decompressBufferToString(row.payload)
    : bufferToUtf8(row.payload);

  const payload = JSON.parse(jsonStr);

  return {
    aggregateId: row.aggregateId,
    blockHeight: row.blockHeight,
    version: row.version,
    payload,
    createdAt: row.createdAt,
  };
}

/**
 * Serialize aggregate state into a snapshot row:
 * - aggregate.toSnapshot() MUST return a JSON string.
 * - For Postgres: compress if it’s beneficial; store compressed bytes in payload; isCompressed=true.
 * - For SQLite: store plain UTF-8 bytes (blob); isCompressed=false.
 */
export async function toSnapshotDataModel<T extends AggregateRoot<DomainEvent>>(
  aggregate: T,
  dbDriver: DriverType = 'postgres'
): Promise<SnapshotDataModel> {
  const { aggregateId, lastBlockHeight, version } = aggregate;
  if (!aggregateId) throw new Error('aggregate Id is missed');
  if (lastBlockHeight == null) throw new Error('lastBlockHeight is missing');
  if (version == null) throw new Error('version is missing');

  const json = aggregate.toSnapshot(); // JSON string
  const isSqlite = dbDriver === 'sqlite';

  let payloadBuf = utf8ToBuffer(json);
  let isCompressed = false;

  if (!isSqlite && CompressionUtils.shouldCompress(json)) {
    try {
      const comp = await CompressionUtils.compressToBuffer(json);
      if (comp.compressedSize < (payloadBuf as any).length * 0.9) {
        payloadBuf = comp.buffer;
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
    createdAt: new Date().toISOString(),
  };
}

export async function toSnapshotReadRow<T extends AggregateRoot<DomainEvent>>(aggregate: T): Promise<SnapshotReadRow> {
  const { aggregateId, lastBlockHeight, version } = aggregate;
  if (!aggregateId) throw new Error('aggregate Id is missed');
  if (lastBlockHeight == null) throw new Error('lastBlockHeight is missing');
  if (version == null) throw new Error('version is missing');

  const payload = aggregate.toSnapshot(); // JSON string

  return {
    modelId: aggregateId,
    blockHeight: lastBlockHeight,
    version,
    payload,
  };
}
