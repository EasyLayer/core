import type { DataSource } from 'typeorm';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { SnapshotDataModel, SnapshotReadRow } from './snapshots.model';
import type { EventReadRow } from './event-data.model';

export interface SnapshotOptions {
  minKeep: number;
  keepWindow: number; // 0 => disabled
}

export interface FindEventsOptions {
  /** Inclusive range for version (both bounds optional). */
  versionGte?: number;
  versionLte?: number;

  /** Inclusive range for height (both bounds optional). */
  heightGte?: number | null;
  heightLte?: number | null;

  /** Limit / pagination. */
  limit?: number;
  offset?: number;

  /** Sort by version or createdAt; default version ASC. */
  orderBy?: 'version' | 'createdAt';
  orderDir?: 'asc' | 'desc';
}

/**
 * Monotonic 64-bit id generator:
 *   id = (timestampMicros << SEQ_BITS) | seq
 * - Ensures strict ordering across all aggregates.
 * - For a single-process writer, SEQ_BITS=10 (1024 events per microsecond) is plenty.
 */
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
    if (ts < this.lastTs) {
      // Guard against clock skew; should never happen in a single process.
      ts = this.lastTs;
    }
    if (ts === this.lastTs) {
      this.seq = (this.seq + 1n) & this.SEQ_MASK;
      if (this.seq === 0n) {
        // Sequence overflow within the same microsecond — bump the timestamp.
        ts = ts + 1n;
      }
    } else {
      this.seq = 0n;
    }
    this.lastTs = ts;
    return (ts << this.SHIFT) | this.seq;
  }
}

/**
 * BaseAdapter declares the contract for EventStore storage engines.
 * This revision focuses on read/rehydration/snapshot APIs.
 */
export abstract class BaseAdapter<T extends AggregateRoot = AggregateRoot> {
  constructor(protected readonly dataSource: DataSource) {}

  // Local id generator
  protected readonly idGen = new MonotonicId(10);

  // ─────────────────────────────── WRITE / OUTBOX (unchanged) ───────────────────────────────

  // ───────────── Write-path (persist + outbox) ─────────────

  /**
   * Persist aggregate tables and outbox in a single transaction.
   * Returns info to decide the publish flow.
   *
   * - insertedOutboxIds: IDs of rows inserted to outbox in this call.
   * - firstTs/firstId: minimal (ts,id) among inserted — to test backlog before us.
   * - lastTs/lastId:  maximal (ts,id) among inserted — watermark helpers.
   * - rawEvents: wire-encoded events (payload as JSON string) for fast-path publish.
   */
  abstract persistAggregatesAndOutbox(aggregates: T[]): Promise<{
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }>;

  abstract hasBacklogBefore(firstTs: number, firstId: string): Promise<boolean>;

  abstract hasAnyPendingAfterWatermark(): Promise<boolean>;

  abstract deleteOutboxByIds(ids: string[]): Promise<void>;

  abstract fetchDeliverAckChunk(
    transportMaxFrameBytes: number,
    publish: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number>;

  abstract rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void>;

  abstract createSnapshot(aggregate: T, opts: SnapshotOptions): Promise<void>;

  // ─────────────────────────────── SNAPSHOTS / REHYDRATION ───────────────────────────────

  /**
   * Returns the latest persisted snapshot regardless of height (DB row shape).
   */
  abstract findLatestSnapshot(aggregateId: string): Promise<SnapshotDataModel | null>;

  /**
   * Returns the latest persisted snapshot with blockHeight <= height (DB row shape).
   */
  abstract findLatestSnapshotBeforeHeight(aggregateId: string, height: number): Promise<SnapshotDataModel | null>;

  /**
   * Apply events with version > fromVersion (no blockHeight filter) to get the freshest state.
   * Used by EventStoreService.getOne(...) after loading from a nearest snapshot.
   */
  abstract applyEventsToAggregate({
    model,
    blockHeight,
    lastVersion,
    batchSize,
  }: {
    model: T;
    blockHeight?: number;
    lastVersion?: number;
    batchSize?: number;
  }): Promise<void>;

  /** Apply assembled state on model for a given height. */
  abstract restoreExactStateAtHeight(model: T, height: number): Promise<void>;

  /** Rehydrate to latest (no height cap): snapshot (if any) + apply tail events. */
  abstract restoreExactStateLatest(model: T): Promise<void>;

  // ─────────────────────────────── READ API (events / snapshots) ───────────────────────────────

  /**
   * Return events for one aggregate (payload returned as JSON string; caller may JSON.parse).
   */
  abstract fetchEventsForOneAggregateRead(aggregateId: string, options?: FindEventsOptions): Promise<EventReadRow[]>;

  /**
   * Return events for many aggregates.
   */
  abstract fetchEventsForManyAggregatesRead(
    aggregateIds: string[],
    options?: FindEventsOptions
  ): Promise<EventReadRow[]>;

  /**
   * Stream events for one aggregate.
   */
  abstract streamEventsForOneAggregateRead(
    aggregateId: string,
    options?: FindEventsOptions
  ): AsyncGenerator<EventReadRow, void, unknown>;

  /**
   * Stream events for many aggregates.
   */
  abstract streamEventsForManyAggregatesRead(
    aggregateIds: string[],
    options?: FindEventsOptions
  ): AsyncGenerator<EventReadRow, void, unknown>;

  /**
   * Return model state at height as RAW SnapshotReadRow (payload is JSON string).
   * IMPORTANT: This method now accepts the MODEL, not id.
   */
  abstract getOneModelByHeightRead(model: T, blockHeight: number): Promise<SnapshotReadRow | null>;

  /**
   * Batch version of getOneModelByHeightRead (MODEL array).
   */
  abstract getManyModelsByHeightRead(models: T[], blockHeight: number): Promise<SnapshotReadRow[]>;
}
