import type { AggregateRoot } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { SnapshotDataModel, SnapshotReadRow } from './snapshots.model';
import type { EventReadRow } from './event-data.model';

export type DriverType = 'postgres' | 'sqlite' | 'sqlite-opfs';

export interface SnapshotOptions {
  minKeep: number;
  keepWindow: number;
  /** Global prune flag — overrides per-aggregate allowPruning. All models share the same files. */
  allowPruning: boolean;
}

export interface OutboxDeliveryAck {
  ok: boolean;
  okIndices?: number[];
  correlationId?: string;
  err?: string;
}

export interface PersistAggregatesOptions {
  /**
   * When false, adapters persist aggregate event tables only and skip outbox rows.
   * This is the local-only mode for runtimes without configured remote transport.
   */
  writeOutbox: boolean;
}

export interface PersistAggregatesResult {
  insertedOutboxIds: string[];
  firstTs: number;
  firstId: string;
  lastTs: number;
  lastId: string;
  rawEvents: WireEventRecord[];
}

export function assertFullOutboxAck(ack: OutboxDeliveryAck, expectedCount: number): void {
  if (!ack || ack.ok !== true) {
    throw new Error(`Outbox delivery failed${ack?.err ? `: ${ack.err}` : ''}`);
  }

  if (!Array.isArray(ack.okIndices)) {
    throw new Error('Outbox delivery ACK must include okIndices');
  }

  if (ack.okIndices.length !== expectedCount) {
    throw new Error(`Outbox delivery ACK is partial: ${ack.okIndices.length}/${expectedCount} events acknowledged`);
  }

  const seen = new Set<number>();
  for (const index of ack.okIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new Error(`Outbox delivery ACK contains invalid index ${index}`);
    }
    if (seen.has(index)) {
      throw new Error(`Outbox delivery ACK contains duplicate index ${index}`);
    }
    seen.add(index);
  }

  for (let i = 0; i < expectedCount; i++) {
    if (!seen.has(i)) throw new Error(`Outbox delivery ACK is missing index ${i}`);
  }
}

export interface FindEventsOptions {
  versionGte?: number;
  versionLte?: number;
  heightGte?: number | null;
  heightLte?: number | null;
  limit?: number;
  offset?: number;
  orderBy?: 'version' | 'createdAt';
  orderDir?: 'asc' | 'desc';
}

class MonotonicId {
  private lastTs = 0n;
  private seq = 0n;
  private readonly SHIFT: bigint;
  private readonly MULT: bigint;
  private readonly SEQ_MASK: bigint;

  constructor(seqBits = 10) {
    this.SHIFT = BigInt(seqBits);
    this.MULT = 1n << this.SHIFT;
    this.SEQ_MASK = this.MULT - 1n;
  }

  next(timestampMicros: number): bigint {
    let ts = BigInt(timestampMicros);
    if (ts < this.lastTs) ts = this.lastTs;
    if (ts === this.lastTs) {
      this.seq = (this.seq + 1n) & this.SEQ_MASK;
      if (this.seq === 0n) ts = ts + 1n;
    } else {
      this.seq = 0n;
    }
    this.lastTs = ts;
    return (ts << this.SHIFT) | this.seq;
  }
}

/**
 * BaseAdapter — storage engine contract.
 * dataSource typed as `any` — no static TypeORM import.
 * Node adapters pass their DataSource; browser adapters pass nothing (null).
 */
export abstract class BaseAdapter<T extends AggregateRoot = AggregateRoot> {
  constructor(protected dataSource: any = null) {}

  protected readonly idGen = new MonotonicId(10);

  abstract persistAggregatesAndOutbox(
    aggregates: T[],
    options: PersistAggregatesOptions
  ): Promise<PersistAggregatesResult>;

  abstract hasBacklogBefore(firstTs: number, firstId: string): Promise<boolean>;
  abstract hasPendingAfterId(lastId: string): Promise<boolean>;
  abstract deleteOutboxByIds(ids: string[]): Promise<void>;
  abstract fetchDeliverAckChunk(
    transportMaxFrameBytes: number,
    publish: (events: WireEventRecord[]) => Promise<OutboxDeliveryAck>
  ): Promise<number>;
  abstract rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void>;
  abstract advanceWatermark(lastId: string): void;
  abstract createSnapshot(aggregate: T, opts: SnapshotOptions, irreversibleHeight?: number): Promise<void>;
  abstract findLatestSnapshot(aggregateId: string): Promise<SnapshotDataModel | null>;
  abstract findLatestSnapshotBeforeHeight(aggregateId: string, height: number): Promise<SnapshotDataModel | null>;
  abstract applyEventsToAggregate(opts: {
    model: T;
    blockHeight?: number;
    lastVersion?: number;
    batchSize?: number;
  }): Promise<void>;
  abstract restoreExactStateAtHeight(model: T, height: number): Promise<void>;
  abstract restoreExactStateLatest(model: T): Promise<void>;
  abstract fetchEventsForOneAggregateRead(aggregateId: string, options?: FindEventsOptions): Promise<EventReadRow[]>;
  abstract fetchEventsForManyAggregatesRead(
    aggregateIds: string[],
    options?: FindEventsOptions
  ): Promise<EventReadRow[]>;
  abstract streamEventsForOneAggregateRead(
    aggregateId: string,
    options?: FindEventsOptions
  ): AsyncGenerator<EventReadRow, void, unknown>;
  abstract streamEventsForManyAggregatesRead(
    aggregateIds: string[],
    options?: FindEventsOptions
  ): AsyncGenerator<EventReadRow, void, unknown>;
  abstract getOneModelByHeightRead(model: T, blockHeight: number): Promise<SnapshotReadRow | null>;
  abstract getManyModelsByHeightRead(models: T[], blockHeight: number): Promise<SnapshotReadRow[]>;
}
