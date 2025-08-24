import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DataSource,
  QueryFailedError,
  Repository,
  MoreThan,
  LessThanOrEqual,
  ObjectLiteral,
  QueryRunner,
} from 'typeorm';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseAdapter, SnapshotRetention, FIXED_OVERHEAD } from './base-adapter';
import { OutboxRowInternal, deserializeToOutboxRaw } from '../outbox.model';
import { EventDataParameters, serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { SnapshotInterface, SnapshotParameters, serializeSnapshot, deserializeSnapshot } from '../snapshots.model';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';

/**
 * sql.js + IndexedDB manual flush:
 * We explicitly export the in-memory DB and persist it to IndexedDB
 * after each write-transaction and on destroy/close.
 */
async function flushSqljsToIndexedDB(ds: DataSource, storageKey: string, log?: AppLogger) {
  try {
    if (typeof window === 'undefined') return;
    const opts: any = ds.options;
    if (opts?.type !== 'sqljs') return;

    // dynamic import to avoid bundling for non-browser envs
    const { default: localforage } = await import('localforage');

    // sql.js exposes `export()` on the underlying database
    const driver: any = ds.driver as any;
    const sqljsDb = driver?.databaseConnection;
    if (!sqljsDb?.export) return;

    const bytes: Uint8Array = sqljsDb.export();
    await localforage.setItem(storageKey, bytes);
  } catch (e) {
    log?.debug('sqljs flush failed', { args: { error: (e as any)?.message } });
  }
}

@Injectable()
export class BrowserSqljsAdapter<T extends AggregateRoot = AggregateRoot>
  extends BaseAdapter<T>
  implements OnModuleInit, OnModuleDestroy
{
  public readonly driver = 'sqljs' as const;

  /**
   * SQLite/sql.js host parameter limit per statement.
   * We compute rows-per-insert from this, based on columns per row.
   */
  private static readonly SQLITE_MAX_PARAMS = 999;

  /** Columns per row in aggregate events table INSERT. */
  private static readonly AGG_COLS_PER_ROW = 6; // type, payload, version, requestId, blockHeight, isCompressed

  /** Columns per row in outbox INSERT. */
  private static readonly OUTBOX_COLS_PER_ROW = 9; // aggregateId, eventType, eventVersion, requestId, blockHeight, payload, timestamp, isCompressed, payload_uncompressed_bytes

  /** Safe rows-per-INSERT for aggregates. */
  private static readonly AGG_ROWS_PER_INSERT = Math.max(
    1,
    Math.floor(BrowserSqljsAdapter.SQLITE_MAX_PARAMS / BrowserSqljsAdapter.AGG_COLS_PER_ROW)
  ); // 999/6 => 166

  /** Safe rows-per-INSERT for outbox. */
  private static readonly OUTBOX_ROWS_PER_INSERT = Math.max(
    1,
    Math.floor(BrowserSqljsAdapter.SQLITE_MAX_PARAMS / BrowserSqljsAdapter.OUTBOX_COLS_PER_ROW)
  ); // 999/9 => 111

  /** Chunk size for IN (...) deletes; keep below 999. */
  private readonly idDeleteChunkSize: number = 900;

  /** Watermark for outbox streaming (global order by (timestamp,id)). */
  private lastSeenTsUs = 0;
  private lastSeenId = 0;

  /** Moving average of row byte size (for adaptive LIMIT). */
  private avgRowBytes = 2048;

  /** LocalForage storage key for persisted sql.js snapshot. */
  private readonly storageKey: string;

  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource
  ) {
    super();
    if ((this.dataSource.options as any)?.type !== 'sqljs') {
      throw new Error('BrowserSqljsAdapter must be used with a sqljs DataSource');
    }
    const dsOpts: any = this.dataSource.options ?? {};
    const baseKey = dsOpts.database || dsOpts.location || 'default';
    this.storageKey = `sqljs:${String(baseKey)}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle hooks
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Apply safe PRAGMAs once per connection and register a final flush hook.
   * Note: Many PRAGMAs are no-ops for sql.js but kept for parity and clarity.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query('PRAGMA foreign_keys = ON;');
      await this.dataSource.query('PRAGMA temp_store = MEMORY;');
      await this.dataSource.query('PRAGMA mmap_size = 67108864;'); // 64MB
      await this.dataSource.query('PRAGMA cache_size = -64000;'); // ~64MB in KiB
    } catch {
      /* ignore */
    }

    // Flush on tab close (best-effort, fire-and-forget)
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        void flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Persist (single tx; single manual flush after COMMIT)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Persist aggregates + outbox in one transaction.
   * We create ONE Buffer per event (optionally compressed) and reuse it for BOTH:
   *  - aggregate tables (payload: BLOB)
   *  - outbox table  (payload: BLOB)
   *
   * IMPORTANT: We batch INSERTs by **rows-per-statement**, derived from
   * the SQLite/sql.js 999-parameter limit and the number of columns per row.
   */
  async persistAggregatesAndOutbox(aggregates: T[]): Promise<void> {
    if (!aggregates.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction(); // BEGIN (DEFERRED)

    try {
      const perAgg = new Map<string, EventDataParameters[]>();
      const outRows: Omit<OutboxRowInternal, 'id'>[] = [];

      for (const agg of aggregates) {
        const unsaved = agg.getUnsavedEvents();
        if (!unsaved.length) continue;

        const base = agg.version - unsaved.length;
        const rows: EventDataParameters[] = [];

        for (let i = 0; i < unsaved.length; i++) {
          const ev = unsaved[i]!;
          const ser = await serializeEventRow(ev, base + i + 1, 'sqljs'); // creates buffers once

          // Aggregate row
          rows.push({
            type: ser.type,
            payload: ser.payload, // same Buffer
            version: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            isCompressed: ser.isCompressed,
            timestamp: ser.timestamp,
          });

          // Outbox row
          outRows.push({
            aggregateId: agg.aggregateId,
            eventType: ser.type,
            eventVersion: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            payload: ser.payload, // same Buffer
            timestamp: ev.timestamp!,
            isCompressed: ser.isCompressed ?? false,
            payload_uncompressed_bytes: ser.payloadUncompressedBytes,
          });
        }

        perAgg.set(agg.aggregateId, rows);
      }

      if (!outRows.length) {
        await qr.commitTransaction();
        await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
        return;
      }

      // INSERT aggregates batched by rows-per-statement (avoid >999 params)
      for (const [aggId, rows] of perAgg.entries()) {
        const repo = qr.manager.getRepository<EventDataParameters>(aggId);
        const step = BrowserSqljsAdapter.AGG_ROWS_PER_INSERT; // 166
        for (let i = 0; i < rows.length; i += step) {
          const batch = rows.slice(i, i + step);
          await repo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // INSERT outbox batched by rows-per-statement (avoid >999 params)
      {
        const outboxRepo = qr.manager.getRepository<OutboxRowInternal>('outbox');
        const step = BrowserSqljsAdapter.OUTBOX_ROWS_PER_INSERT; // 111
        for (let i = 0; i < outRows.length; i += step) {
          const batch = outRows.slice(i, i + step);
          await outboxRepo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // Mark all events as saved
      for (const agg of aggregates) agg.markEventsAsSaved();

      await qr.commitTransaction();
      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } catch (err) {
      await qr.rollbackTransaction().catch(() => undefined);
      if (!(err instanceof QueryFailedError)) throw err;
      throw err;
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  // ======== Outbox streaming: read ORDER BY (timestamp,id) -> ACK -> IMMEDIATE delete ========
  async fetchDeliverAckChunk(
    wireBudgetBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    const ids: number[] = [];
    const events: WireEventRecord[] = [];
    let budget = wireBudgetBytes;

    while (true) {
      // Read one row at a time to maintain strict watermark semantics
      const rows = (await this.dataSource.query(
        `SELECT id, aggregateId, eventType, eventVersion, requestId, blockHeight,
                payload, isCompressed, payload_uncompressed_bytes AS ulen, "timestamp"
          FROM outbox
          WHERE ("timestamp" > ? OR ("timestamp" = ? AND id > ?))
          ORDER BY "timestamp" ASC, id ASC
          LIMIT 1`,
        [this.lastSeenTsUs, this.lastSeenTsUs, this.lastSeenId]
      )) as Array<{
        id: number;
        aggregateId: string;
        eventType: string;
        eventVersion: number;
        requestId: string;
        blockHeight: number; // may be NULL in DB
        payload: Buffer;
        isCompressed: number | boolean; // SQLite may return 0/1
        ulen: number; // payload_uncompressed_bytes
        timestamp: number;
      }>;

      if (rows.length === 0) break;

      const r = rows[0]!;

      // Compute row size BEFORE decompressing and BEFORE moving the watermark.
      const rowBytes = FIXED_OVERHEAD + Number(r.ulen);

      // If we already have at least one event and this row won't fit — stop.
      // IMPORTANT: do not move watermark in this case, otherwise the row will be skipped.
      if (events.length > 0 && rowBytes > budget) break;

      // Accept row → build WireEventRecord in one helper (decompress if needed).
      const evt = await deserializeToOutboxRaw({
        aggregateId: r.aggregateId,
        eventType: r.eventType,
        eventVersion: r.eventVersion,
        requestId: r.requestId,
        blockHeight: r.blockHeight,
        payload: r.payload,
        isCompressed: !!r.isCompressed,
        timestamp: r.timestamp,
      });

      ids.push(r.id);
      events.push(evt);

      // Move watermark ONLY after we actually accepted the row.
      // This guarantees at-least-once delivery when budget stops us.
      this.lastSeenTsUs = Number(r.timestamp);
      this.lastSeenId = Number(r.id);

      // Update remaining budget.
      budget = Math.max(0, budget - rowBytes);
    }

    if (events.length === 0) return 0;

    // We send one batch and wait for a single ACK
    await deliver(events);

    // Remove ACK'ed ids (chunk IN(...) to keep params < 999)
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN IMMEDIATE');

    try {
      const step = this.idDeleteChunkSize; // 900
      for (let i = 0; i < ids.length; i += step) {
        const chunk = ids.slice(i, i + step);
        await qr.manager.query(`DELETE FROM outbox WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
      }
      await qr.query('COMMIT');
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }

    return events.length;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rollback
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Roll back events/snapshots for given aggregates over a height,
   * then purge corresponding outbox rows. Uses short transactions per table
   * and a single chunked transaction for outbox. Manual flush once at the end.
   */
  async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (!aggregateIds.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    try {
      // Per-aggregate cleanup (events + snapshots) in short transactions
      for (const tableName of aggregateIds) {
        // Events
        await qr.startTransaction();
        try {
          await qr.manager.query(`DELETE FROM "${tableName}" WHERE blockHeight > ?`, [blockHeight]);
          await qr.commitTransaction();
        } catch (e) {
          await qr.rollbackTransaction().catch(() => undefined);
          throw new Error(`Failed to delete events for ${tableName}: ${(e as Error).message}`);
        }

        // Snapshots
        await qr.startTransaction();
        try {
          await qr.manager.query(`DELETE FROM snapshots WHERE "aggregateId" = ? AND "blockHeight" > ?`, [
            tableName,
            blockHeight,
          ]);
          await qr.commitTransaction();
        } catch (e) {
          await qr.rollbackTransaction().catch(() => undefined);
          throw new Error(`Failed to delete snapshots for ${tableName}: ${(e as Error).message}`);
        }
      }

      // Outbox cleanup for all aggregates (one txn, chunked IN)
      await qr.startTransaction();
      try {
        for (let i = 0; i < aggregateIds.length; i += this.idDeleteChunkSize) {
          const chunk = aggregateIds.slice(i, i + this.idDeleteChunkSize);
          const placeholders = chunk.map(() => '?').join(',');
          await qr.manager.query(
            `DELETE FROM outbox
             WHERE "aggregateId" IN (${placeholders})
               AND "blockHeight" > ?`,
            [...chunk, blockHeight]
          );
        }
        await qr.commitTransaction();
      } catch (e) {
        await qr.rollbackTransaction().catch(() => undefined);
        throw new Error(`Failed to delete outbox rows: ${(e as Error).message}`);
      }

      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rehydrate at height
  // ─────────────────────────────────────────────────────────────────────────────

  async rehydrateAtHeight<K extends T>(model: K, blockHeight: number): Promise<void> {
    const { aggregateId } = model;
    if (!aggregateId) throw new Error('Model does not have aggregateId');

    const snap = await this.findSnapshotBeforeHeight(aggregateId, blockHeight);
    if (!snap) {
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
      return;
    }

    const decomp = await deserializeSnapshot(snap, 'sqljs');
    model.fromSnapshot(decomp);

    if (snap.blockHeight < blockHeight) {
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Snapshots
  // ─────────────────────────────────────────────────────────────────────────────

  async findLatestSnapshot(aggregateId: string): Promise<SnapshotInterface | null> {
    const repo = this.getRepository<SnapshotInterface>('snapshots');
    return await repo
      .createQueryBuilder('s')
      .where('s.aggregateId = :aggregateId', { aggregateId })
      .orderBy('s.blockHeight', 'DESC')
      .limit(1)
      .getOne();
  }

  async findSnapshotBeforeHeight(aggregateId: string, blockHeight: number): Promise<SnapshotInterface | null> {
    const repo = this.getRepository<SnapshotInterface>('snapshots');
    return await repo
      .createQueryBuilder('s')
      .where('s.aggregateId = :aggregateId', { aggregateId })
      .andWhere('s.blockHeight <= :blockHeight', { blockHeight })
      .orderBy('s.blockHeight', 'DESC')
      .limit(1)
      .getOne();
  }

  /**
   * Create snapshot in a short write transaction and flush once.
   * Applies optional retention afterwards within the same transaction.
   */
  async createSnapshot(aggregate: T, ret?: SnapshotRetention): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const snapshot = await serializeSnapshot(aggregate as any, 'sqljs');
      await qr.manager
        .getRepository<SnapshotInterface>('snapshots')
        .createQueryBuilder()
        .insert()
        .values(snapshot)
        .updateEntity(false)
        .execute();

      aggregate.resetSnapshotCounter();

      if (aggregate.allowPruning) {
        await this.applySnapshotRetentionTx(qr, aggregate.aggregateId, snapshot.blockHeight, ret);
      }

      await qr.commitTransaction();
      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } catch (error) {
      await qr.rollbackTransaction().catch(() => undefined);
      if (error instanceof QueryFailedError) {
        const code = (error.driverError as any)?.code;
        if (code === 'SQLITE_CONSTRAINT') {
          this.log.debug('Snapshot conflict, skipping', { args: { aggregateId: aggregate.aggregateId } });
          return;
        }
      }
      throw error;
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (!aggregateIds.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository<SnapshotInterface>('snapshots');
      for (const aggregateId of aggregateIds) {
        await repo
          .createQueryBuilder()
          .delete()
          .where('aggregateId = :aggregateId', { aggregateId })
          .andWhere('blockHeight > :blockHeight', { blockHeight })
          .execute();
      }
      await qr.commitTransaction();
      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw e;
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.applySnapshotRetentionTx(qr, aggregateId, currentBlockHeight);
      await qr.commitTransaction();
      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw e;
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const repo = qr.manager.getRepository(aggregateId);
      await repo
        .createQueryBuilder()
        .delete()
        .where('blockHeight < :blockHeight', { blockHeight: pruneToBlockHeight })
        .execute();
      await qr.commitTransaction();
      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw e;
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  async createSnapshotAtHeight<K extends T>(model: K, blockHeight: number): Promise<SnapshotParameters> {
    const { aggregateId } = model;
    if (!aggregateId) throw new Error('Model does not have aggregateId');

    const snap = await this.findSnapshotBeforeHeight(aggregateId, blockHeight);
    if (!snap) {
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'sqljs');
      model.fromSnapshot(decomp);
      if (snap.blockHeight < blockHeight) {
        await this.applyEventsToAggregateAtHeight(model, blockHeight);
      }
    }
    return { aggregateId, blockHeight: model.lastBlockHeight, version: model.version, payload: model.toSnapshot() };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────────────────────────────────────

  async fetchEventsForAggregate(
    aggregateId: string,
    options: { version?: number; blockHeight?: number; limit?: number; offset?: number } = {}
  ) {
    const { version, blockHeight, limit, offset } = options;
    const repo = this.getRepository(aggregateId);
    const qb = repo
      .createQueryBuilder('e')
      .where('e.version > :version', { version: version ?? 0 })
      .addOrderBy('e.version', 'ASC');

    if (blockHeight != null) qb.andWhere('e.blockHeight <= :bh', { bh: blockHeight });
    if (offset != null) qb.skip(offset);
    if (limit != null) qb.take(limit);

    const raws: any[] = await qb.getMany();
    return await Promise.all(raws.map((r) => deserializeToDomainEvent(aggregateId, r, 'sqljs')));
  }

  async fetchEventsForAggregates(
    aggregateIds: string[],
    options: { version?: number; blockHeight?: number; limit?: number; offset?: number } = {}
  ) {
    const results = await Promise.all(aggregateIds.map((id) => this.fetchEventsForAggregate(id, options)));
    return results.flat();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * TypeORM repo by entity name registered in the DataSource.
   * We resolve metadata first to guarantee the proper target is used.
   */
  private getRepository<T extends ObjectLiteral = any>(entityName: string): Repository<T> {
    const meta =
      (this.dataSource as any).entityMetadatasMap?.get(entityName) ??
      this.dataSource.entityMetadatas.find((m) => m.name === entityName);
    if (!meta) throw new Error(`Entity with name "${entityName}" not found.`);
    return this.dataSource.getRepository<T>(meta.target);
  }

  /**
   * Load events to the aggregate up to (and including) the given blockHeight.
   * Reads in ascending version order in batches for memory efficiency.
   */
  private async applyEventsToAggregateAtHeight<K extends T>(model: K, blockHeight: number): Promise<void> {
    const repo = this.getRepository(model.aggregateId);
    const batch = 5000;
    let last = 0;

    while (true) {
      const raws: any[] = await repo.find({
        where: { version: MoreThan(last), blockHeight: LessThanOrEqual(blockHeight) },
        order: { version: 'ASC' },
        take: batch,
      });
      if (!raws.length) break;

      const events = await Promise.all(raws.map((r) => deserializeToDomainEvent(model.aggregateId, r, 'sqljs')));
      await model.loadFromHistory(events);

      last = raws[raws.length - 1]!.version;
      if (raws.length < batch) break;
    }
  }

  /**
   * Apply snapshot retention inside an existing transaction (query runner provided).
   * Keeps last `minKeep` snapshots and optionally preserves a height window.
   */
  private async applySnapshotRetentionTx(
    qr: QueryRunner,
    aggregateId: string,
    currentHeight: number,
    ret?: SnapshotRetention
  ) {
    const minKeep = ret?.minKeep ?? 2;
    const win = ret?.keepWindow ?? 0;

    const repo = qr.manager.getRepository<SnapshotInterface>('snapshots');

    // Pick the newest `minKeep` snapshot IDs
    const keepRows: Array<{ id: string; blockHeight: number }> = await repo
      .createQueryBuilder('s')
      .select(['s.id AS id', 's.blockHeight AS blockHeight'])
      .where('s.aggregateId = :aggregateId', { aggregateId })
      .orderBy('s.blockHeight', 'DESC')
      .limit(minKeep)
      .getRawMany();

    const keepIds = new Set(keepRows.map((r) => r.id));
    const minHeight = win > 0 ? Math.max(0, currentHeight - win) : -Infinity;

    // Build delete query: below minHeight and NOT in keepIds
    const qb = repo.createQueryBuilder().delete().where('aggregateId = :aggregateId', { aggregateId });

    if (minHeight !== -Infinity) {
      qb.andWhere('blockHeight < :bh', { bh: minHeight });
    } else {
      qb.andWhere('1=1');
    }

    if (keepIds.size) {
      qb.andWhere(`id NOT IN (${[...keepIds].map(() => '?').join(',')})`, [...keepIds]);
    }

    await qb.execute();
  }
}
