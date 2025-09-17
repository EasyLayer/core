import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import type { SnapshotInterface, SnapshotParameters } from '../core';
import { utf8ToBuffer, bufferToUtf8 } from './bytes';

/**
 * Deserialize snapshot DB row into in-memory object with parsed payload.
 * Browser build: compression is disabled entirely.
 */
export async function deserializeSnapshot(row: SnapshotInterface): Promise<SnapshotParameters> {
  if ((row as any).isCompressed) {
    throw new Error('Compressed snapshot payload is not supported in browser build');
  }

  const jsonStr = bufferToUtf8(row.payload);
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
 * Browser build: always plain UTF-8 bytes, no compression.
 */
export async function serializeSnapshot<T extends AggregateRoot<DomainEvent>>(
  aggregate: T
): Promise<Omit<SnapshotInterface, 'id' | 'createdAt'>> {
  const { aggregateId, lastBlockHeight, version } = aggregate;
  if (!aggregateId) throw new Error('aggregate Id is missed');
  if (lastBlockHeight == null) throw new Error('lastBlockHeight is missing');
  if (version == null) throw new Error('version is missing');

  const json = aggregate.toSnapshot(); // JSON string

  return {
    aggregateId,
    blockHeight: lastBlockHeight,
    version,
    payload: utf8ToBuffer(json),
    isCompressed: false, // never compressed in browser
  };
}
