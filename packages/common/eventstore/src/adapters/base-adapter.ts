import type { DataSource } from 'typeorm';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';

export type DriverType = 'postgres' | 'sqlite' | 'sqljs';

export interface SnapshotOptions {
  minKeep: number;
  keepWindow: number; // 0 => disabled
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
 * BaseAdapter describes the contract that concrete adapters must implement.
 * All chunk sizing / EMA logic is adapter-owned.
 * The service passes only the 'transportCapBytes' into fetchDeliverAckChunk().
 */
export abstract class BaseAdapter<T extends AggregateRoot = AggregateRoot> {
  constructor(protected readonly dataSource: DataSource) {}

  // Local id generator
  protected readonly idGen = new MonotonicId(10);

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
  public abstract persistAggregatesAndOutbox(aggregates: T[]): Promise<{
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }>;

  /** Delete by ids after ACK. Must chunk by placeholder limits where necessary. */
  public abstract deleteOutboxByIds(ids: string[]): Promise<void>;

  // ───────────── Backlog tests / watermark ─────────────

  /** Checks if there are outbox rows strictly before (ts,id). */
  public abstract hasBacklogBefore(ts: number, id: string): Promise<boolean>;

  /** Checks if there is anything pending after the current adapter watermark. */
  public abstract hasAnyPendingAfterWatermark(): Promise<boolean>;

  /**
   * Fetch→deliver→ACK a chunk sized to stay under 'transportCapBytes'.
   * Returns number of events delivered (0 means nothing pending).
   * Adapter is free to use window SUM + EMA internally.
   */
  public abstract fetchDeliverAckChunk(
    transportCapBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number>;

  // ───────────── Snapshots / Read-path ─────────────

  public abstract createSnapshot(aggregate: T, opts: SnapshotOptions): Promise<void>;

  public abstract findLatestSnapshot(aggregateId: string): Promise<{ blockHeight: number } | null>;

  public abstract createSnapshotAtHeight<K extends T>(
    model: K,
    height: number
  ): Promise<{ aggregateId: string; version: number; blockHeight: number; payload: any }>;

  public abstract applyEventsToAggregate<K extends T>(model: K, fromVersion?: number): Promise<void>;

  public abstract deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void>;

  public abstract pruneOldSnapshots(
    aggregateId: string,
    currentBlockHeight: number,
    opts: SnapshotOptions
  ): Promise<void>;

  public abstract pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void>;

  public abstract rehydrateAtHeight<K extends T>(model: K, blockHeight: number): Promise<void>;

  public abstract rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void>;

  // ───────────── Read API passthroughs used by service ─────────────

  public abstract fetchEventsForAggregates(
    aggregateIds: string[],
    options?: { version?: number; blockHeight?: number; limit?: number; offset?: number }
  ): Promise<DomainEvent[]>;
}
