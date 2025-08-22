import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { OutboxRowInternal } from '../outbox.model';
import type { SnapshotParameters, SnapshotInterface } from '../snapshots.model';

export type DriverType = 'sqlite' | 'postgres';

export class NotSupportedError extends Error {
  constructor(method: string, driver: DriverType) {
    super(`${method} is not supported by ${driver} adapter`);
  }
}

export abstract class BaseAdapter<T extends AggregateRoot = AggregateRoot> {
  abstract readonly driver: DriverType;

  // Write path
  async persistAggregatesAndOutbox(_aggregates: T[]): Promise<void> {
    throw new NotSupportedError('persistAggregatesAndOutbox', this.driver);
  }

  // Wire conversion (fallback use)
  async toWireEvents(_rows: OutboxRowInternal[]): Promise<WireEventRecord[]> {
    throw new NotSupportedError('toWireEvents', this.driver);
  }

  // New: one-chunk streaming with precise byte budget + ACK
  async fetchDeliverAckChunk(
    _wireBudgetBytes: number,
    _deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    throw new NotSupportedError('fetchDeliverAckChunk', this.driver);
  }

  // Read / snapshots
  async findLatestSnapshot(_aggregateId: string): Promise<SnapshotInterface | null> {
    throw new NotSupportedError('findLatestSnapshot', this.driver);
  }
  async findSnapshotBeforeHeight(_aggregateId: string, _blockHeight: number): Promise<SnapshotInterface | null> {
    throw new NotSupportedError('findSnapshotBeforeHeight', this.driver);
  }
  async applyEventsToAggregate<K extends T>(_model: K, _fromVersion?: number): Promise<void> {
    throw new NotSupportedError('applyEventsToAggregate', this.driver);
  }
  async createSnapshot(_aggregate: T): Promise<void> {
    throw new NotSupportedError('createSnapshot', this.driver);
  }
  async deleteSnapshotsByBlockHeight(_aggregateIds: string[], _blockHeight: number): Promise<void> {
    throw new NotSupportedError('deleteSnapshotsByBlockHeight', this.driver);
  }
  async pruneOldSnapshots(_aggregateId: string, _currentBlockHeight: number): Promise<void> {
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
