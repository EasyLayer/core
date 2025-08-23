import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { SnapshotParameters, SnapshotInterface } from '../snapshots.model';

export type DriverType = 'sqlite' | 'postgres' | 'sqljs';

export const FIXED_OVERHEAD = 256;

export class NotSupportedError extends Error {
  constructor(method: string, driver: DriverType) {
    super(`${method} is not supported by ${driver} adapter`);
  }
}

export interface SnapshotRetention {
  minKeep?: number; // keep at least N snapshots
  keepWindow?: number; // keep snapshots with blockHeight >= (currentHeight - keepWindow)
}

export abstract class BaseAdapter<T extends AggregateRoot = AggregateRoot> {
  abstract readonly driver: DriverType;

  // ===== persist
  async persistAggregatesAndOutbox(_aggregates: T[]): Promise<void> {
    throw new NotSupportedError('persistAggregatesAndOutbox', this.driver);
  }

  // ===== outbox delivery
  async fetchDeliverAckChunk(
    _wireBudgetBytes: number,
    _deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    throw new NotSupportedError('fetchDeliverAckChunk', this.driver);
  }

  // ===== rollback
  async rollbackAggregates(_aggregateIds: string[], _blockHeight: number): Promise<void> {
    throw new NotSupportedError('rollbackAggregates', this.driver);
  }

  async rehydrateAtHeight<K extends T>(_model: K, _blockHeight: number): Promise<void> {
    throw new NotSupportedError('rehydrateAtHeight', this.driver);
  }

  // ===== snapshots / reads
  async findLatestSnapshot(_aggregateId: string): Promise<SnapshotInterface | null> {
    throw new NotSupportedError('findLatestSnapshot', this.driver);
  }

  async findSnapshotBeforeHeight(_aggregateId: string, _blockHeight: number): Promise<SnapshotInterface | null> {
    throw new NotSupportedError('findSnapshotBeforeHeight', this.driver);
  }

  async applyEventsToAggregate<K extends T>(_model: K, _fromVersion?: number): Promise<void> {
    throw new NotSupportedError('applyEventsToAggregate', this.driver);
  }

  async createSnapshot(_aggregate: T, _ret?: SnapshotRetention): Promise<void> {
    throw new NotSupportedError('createSnapshot', this.driver);
  }

  async deleteSnapshotsByBlockHeight(_aggregateIds: string[], _blockHeight: number): Promise<void> {
    throw new NotSupportedError('deleteSnapshotsByBlockHeight', this.driver);
  }

  async pruneOldSnapshots(_aggregateId: string, _currentBlockHeight: number, _ret?: SnapshotRetention): Promise<void> {
    throw new NotSupportedError('pruneOldSnapshots', this.driver);
  }

  async pruneEvents(_aggregateId: string, _pruneToBlockHeight: number): Promise<void> {
    throw new NotSupportedError('pruneEvents', this.driver);
  }

  async createSnapshotAtHeight<K extends T>(_model: K, _blockHeight: number): Promise<SnapshotParameters> {
    throw new NotSupportedError('createSnapshotAtHeight', this.driver);
  }

  async fetchEventsForAggregate(
    _aggregateId: string,
    _options?: { version?: number; blockHeight?: number; limit?: number; offset?: number }
  ): Promise<DomainEvent[]> {
    throw new NotSupportedError('fetchEventsForAggregate', this.driver);
  }

  async fetchEventsForAggregates(
    _aggregateIds: string[],
    _options?: { version?: number; blockHeight?: number; limit?: number; offset?: number }
  ): Promise<DomainEvent[]> {
    throw new NotSupportedError('fetchEventsForAggregates', this.driver);
  }
}
