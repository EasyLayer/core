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
import { OutboxRowInternal } from '../outbox.model';
import { EventDataParameters, serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { SnapshotInterface, SnapshotParameters, serializeSnapshot, deserializeSnapshot } from '../snapshots.model';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import { CompressionUtils } from '../compression';

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

  /** Max rows per INSERT/DELETE batch (keep < 999 — SQLite param limit). */
  private readonly sqljsBatchSize: number = 900;

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
            payload: ser.payloadAggregate, // same Buffer
            version: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            isCompressed: ser.isCompressed,
          });

          outRows.push({
            aggregateId: agg.aggregateId,
            eventType: ser.type,
            eventVersion: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            payload: ser.payloadOutbox, // same Buffer
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

      // Insert aggregates batched
      for (const [aggId, rows] of perAgg.entries()) {
        const repo = qr.manager.getRepository<EventDataParameters>(aggId);
        for (let i = 0; i < rows.length; i += this.sqljsBatchSize) {
          const batch = rows.slice(i, i + this.sqljsBatchSize);
          await repo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // Insert outbox in one go (sql.js handles large INSERT well; split if needed)
      const outboxRepo = qr.manager.getRepository<OutboxRowInternal>('outbox');
      for (let i = 0; i < outRows.length; i += this.sqljsBatchSize) {
        const batch = outRows.slice(i, i + this.sqljsBatchSize);
        await outboxRepo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Outbox streaming: read ORDER BY (timestamp,id) → deliver → ACK delete
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Outbox streaming for sql.js (IndexedDB-backed).
   * - Single connection; use a (timestamp,id) watermark.
   * - Adaptive LIMIT to reduce round-trips.
   * - Chunked DELETE to avoid the 999-parameter limit.
   * - Manual flush after COMMIT.
   */
  async fetchDeliverAckChunk(
    wireBudgetBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    const ids: number[] = [];
    const events: WireEventRecord[] = [];

    // Adaptive LIMIT based on moving average
    const est = Math.max(512, this.avgRowBytes);
    const maxLimit = 256; // reasonable upper bound for UI/web
    let budget = wireBudgetBytes;
    let limit = Math.max(1, Math.min(maxLimit, Math.floor(budget / est)));

    const rows = (await this.dataSource.query(
      `SELECT id, aggregateId, eventType, eventVersion, requestId, blockHeight,
              payload, isCompressed, payload_uncompressed_bytes AS ulen, "timestamp"
       FROM outbox
       WHERE ("timestamp" > ? OR ("timestamp" = ? AND id > ?))
       ORDER BY "timestamp" ASC, id ASC
       LIMIT ?`,
      [this.lastSeenTsUs, this.lastSeenTsUs, this.lastSeenId, limit]
    )) as Array<{
      id: number;
      aggregateId: string;
      eventType: string;
      eventVersion: number;
      requestId: string;
      blockHeight: number | null;
      payload: Buffer;
      isCompressed: number | boolean;
      ulen: number;
      timestamp: number;
    }>;

    if (rows.length === 0) return 0;

    for (const r of rows) {
      const rowBytes = FIXED_OVERHEAD + Number(r.ulen);
      if (events.length > 0 && rowBytes > budget) break;

      // Move the watermark strictly by (timestamp,id)
      this.lastSeenTsUs = Number(r.timestamp);
      this.lastSeenId = Number(r.id);

      // Current wire contract: deliver JSON string (decompress if needed)
      const compressed = !!r.isCompressed;
      const jsonStr = compressed ? await CompressionUtils.decompressAny(r.payload) : r.payload.toString('utf8');

      ids.push(r.id);
      events.push({
        modelName: r.aggregateId,
        eventType: r.eventType,
        eventVersion: Number(r.eventVersion),
        requestId: r.requestId,
        blockHeight: Number(r.blockHeight),
        payload: jsonStr,
        timestamp: Number(r.timestamp),
      });

      // Update moving average & budget
      this.avgRowBytes = 0.9 * this.avgRowBytes + 0.1 * rowBytes;
      budget = Math.max(0, budget - rowBytes);
    }

    if (events.length === 0) return 0;

    // Deliver one batch, expect a single ACK
    await deliver(events);

    // Delete ACK'ed ids (chunked)
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      for (let i = 0; i < ids.length; i += this.sqljsBatchSize) {
        const chunk = ids.slice(i, i + this.sqljsBatchSize);
        await qr.manager.query(`DELETE FROM outbox WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
      }
      await qr.commitTransaction();
      await flushSqljsToIndexedDB(this.dataSource, this.storageKey, this.log);
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw e;
    } finally {
      await qr.release().catch(() => undefined);
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
        for (let i = 0; i < aggregateIds.length; i += this.sqljsBatchSize) {
          const chunk = aggregateIds.slice(i, i + this.sqljsBatchSize);
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

  async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number, ret?: SnapshotRetention): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.applySnapshotRetentionTx(qr, aggregateId, currentBlockHeight, ret);
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
      // If no window, allow everything except keepIds
      qb.andWhere('1=1');
    }

    if (keepIds.size) {
      qb.andWhere(`id NOT IN (${[...keepIds].map(() => '?').join(',')})`, [...keepIds]);
    }

    await qb.execute();
  }
}
