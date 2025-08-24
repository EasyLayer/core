import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource, QueryFailedError, Repository, MoreThan, LessThanOrEqual, ObjectLiteral } from 'typeorm';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseAdapter, SnapshotRetention, FIXED_OVERHEAD } from './base-adapter';
import { OutboxRowInternal, deserializeToOutboxRaw } from '../outbox.model';
import { EventDataParameters, serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { SnapshotInterface, SnapshotParameters, serializeSnapshot, deserializeSnapshot } from '../snapshots.model';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';

@Injectable()
export class SqliteEventStoreAdapter<T extends AggregateRoot = AggregateRoot>
  extends BaseAdapter<T>
  implements OnModuleInit
{
  public readonly driver = 'sqlite' as const;

  /**
   * SQLite host parameter limit per statement (placeholders `?`).
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
    Math.floor(SqliteEventStoreAdapter.SQLITE_MAX_PARAMS / SqliteEventStoreAdapter.AGG_COLS_PER_ROW)
  ); // 999/6 => 166

  /** Safe rows-per-INSERT for outbox. */
  private static readonly OUTBOX_ROWS_PER_INSERT = Math.max(
    1,
    Math.floor(SqliteEventStoreAdapter.SQLITE_MAX_PARAMS / SqliteEventStoreAdapter.OUTBOX_COLS_PER_ROW)
  ); // 999/9 => 111

  /** Chunk size for IN (...) deletes; keep below 999 to be safe. */
  private readonly idDeleteChunkSize: number = 900;

  private lastSeenTsUs = 0;
  private lastSeenId = 0;

  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource
  ) {
    super();
    if (this.dataSource.options.type !== 'sqlite') {
      throw new Error('SqliteEventStoreAdapter must be used with SQLite DataSource');
    }
  }

  async onModuleInit() {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    await qr.query('PRAGMA foreign_keys = ON;');
    await qr.query('PRAGMA journal_mode = WAL;');
    await qr.query('PRAGMA synchronous = NORMAL;');
    await qr.query('PRAGMA temp_store = MEMORY;');
    await qr.query('PRAGMA mmap_size = 67108864;');
    await qr.query('PRAGMA cache_size = -64000;');
    await qr.query('PRAGMA busy_timeout = 3000;');
    await qr.query('PRAGMA journal_size_limit = 67108864;');
    await qr.query('PRAGMA wal_autocheckpoint = 10000;'); //~40MB
    await qr.release();
  }

  // ======== Persist (single tx; PRAGMA OFF/ON) ========

  /**
   * Persist aggregates + outbox in a single transaction.
   * We create ONE Buffer per event (optionally compressed) and reuse it for BOTH:
   *  - aggregate tables (payload: BLOB)
   *  - outbox table  (payload: BLOB)
   *
   * IMPORTANT: INSERTs are batched by **rows-per-statement**, derived from
   * SQLite’s 999-parameter limit and the number of columns per row.
   */
  async persistAggregatesAndOutbox(aggregates: T[]): Promise<void> {
    if (!aggregates.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    await qr.query('PRAGMA foreign_keys = OFF;');
    await qr.startTransaction(); // BEGIN (DEFERRED)

    try {
      const perAgg = new Map<string, EventDataParameters[]>(); // rows for aggregate tables
      const outRows: Omit<OutboxRowInternal, 'id'>[] = []; // rows for outbox

      // Build both sets in one pass
      for (const agg of aggregates) {
        const unsaved = agg.getUnsavedEvents();
        if (!unsaved.length) continue;

        const base = agg.version - unsaved.length;
        const rows: EventDataParameters[] = [];

        for (let i = 0; i < unsaved.length; i++) {
          const ev = unsaved[i]!;
          const ser = await serializeEventRow(ev, base + i + 1, 'sqlite'); // ONE buffer created inside

          // aggregate row (binary payload)
          rows.push({
            type: ser.type,
            payload: ser.payload, // same Buffer
            version: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            isCompressed: ser.isCompressed,
            timestamp: ser.timestamp,
          });

          // outbox row (binary payload, plus uncompressed length)
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
        return;
      }

      // INSERT aggregate rows batched by rows-per-statement
      for (const [aggId, rows] of perAgg.entries()) {
        const repo = qr.manager.getRepository<EventDataParameters>(aggId);
        const step = SqliteEventStoreAdapter.AGG_ROWS_PER_INSERT; // 166
        for (let i = 0; i < rows.length; i += step) {
          const batch = rows.slice(i, i + step);
          await repo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // INSERT outbox rows batched by rows-per-statement
      {
        const outboxRepo = qr.manager.getRepository<OutboxRowInternal>('outbox');
        const step = SqliteEventStoreAdapter.OUTBOX_ROWS_PER_INSERT; // 111
        for (let i = 0; i < outRows.length; i += step) {
          const batch = outRows.slice(i, i + step);
          await outboxRepo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // Mark events saved on aggregates (entire batch is one tx)
      for (const agg of aggregates) agg.markEventsAsSaved();

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      if (!(err instanceof QueryFailedError)) throw err;
      throw err;
    } finally {
      await qr.query('PRAGMA foreign_keys = ON;');
      await qr.release();
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

  /**
   * Roll back events/snapshots for given aggregates above a block height,
   * and purge corresponding outbox rows. SQLite-optimized:
   * - Short IMMEDIATE transactions per table to minimize writer blocking
   * - Chunked IN(...) deletes to avoid the 999-parameter limit
   * - Safe early return on empty input
   *
   * Note: this version assumes aggregateIds are valid table names that are already trusted.
   */
  async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (!aggregateIds.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    try {
      // 1) Per-aggregate cleanup (events table + snapshots rows)
      for (const tableName of aggregateIds) {
        // Events
        await qr.query('BEGIN IMMEDIATE');
        try {
          await qr.manager.query(`DELETE FROM "${tableName}" WHERE blockHeight > ?`, [blockHeight]);
          await qr.query('COMMIT');
        } catch (e) {
          await qr.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Failed to delete events for ${tableName}: ${(e as Error).message}`);
        }

        // Snapshots
        await qr.query('BEGIN IMMEDIATE');
        try {
          await qr.manager.query(`DELETE FROM snapshots WHERE "aggregateId" = ? AND "blockHeight" > ?`, [
            tableName,
            blockHeight,
          ]);
          await qr.query('COMMIT');
        } catch (e) {
          await qr.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Failed to delete snapshots for ${tableName}: ${(e as Error).message}`);
        }
      }

      // 2) Outbox cleanup for affected aggregates (chunked IN(...) deletes)
      await qr.query('BEGIN IMMEDIATE');
      try {
        const step = this.idDeleteChunkSize; // 900
        for (let i = 0; i < aggregateIds.length; i += step) {
          const chunk = aggregateIds.slice(i, i + step);
          const placeholders = chunk.map(() => '?').join(',');

          await qr.manager.query(
            `DELETE FROM outbox
             WHERE "aggregateId" IN (${placeholders})
               AND "blockHeight" > ?`,
            [...chunk, blockHeight]
          );
        }
        await qr.query('COMMIT');
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Failed to delete outbox rows: ${(e as Error).message}`);
      }
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  async rehydrateAtHeight<K extends T>(model: K, blockHeight: number): Promise<void> {
    const { aggregateId } = model;
    if (!aggregateId) throw new Error('Model does not have aggregateId');

    const snap = await this.findSnapshotBeforeHeight(aggregateId, blockHeight);
    if (!snap) {
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
      return;
    }
    if (snap.blockHeight < blockHeight) {
      const decomp = await deserializeSnapshot(snap, 'sqlite');
      model.fromSnapshot(decomp);
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'sqlite');
      model.fromSnapshot(decomp);
    }
  }

  // ======== Read / Snapshots ========

  async findLatestSnapshot(aggregateId: string): Promise<SnapshotInterface | null> {
    const repo = this.getRepository<SnapshotInterface>('snapshots');
    return await repo.findOneBy({ aggregateId });
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

  async applyEventsToAggregate<K extends T>(model: K, fromVersion: number = 0): Promise<void> {
    const repo = this.getRepository(model.aggregateId);
    const batch = 5000;
    let last = fromVersion;
    while (true) {
      const raws: any[] = await repo.find({
        where: { version: MoreThan(last) },
        order: { version: 'ASC' },
        take: batch,
      });
      if (!raws.length) break;
      const events = await Promise.all(raws.map((r) => deserializeToDomainEvent(model.aggregateId, r, 'sqlite')));
      await model.loadFromHistory(events);
      last = raws[raws.length - 1]!.version;
      if (raws.length < batch) break;
    }
  }

  async createSnapshot(aggregate: T, ret?: SnapshotRetention): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;
    try {
      const snapshot = await serializeSnapshot(aggregate as any, 'sqlite');
      const repo = this.getRepository('snapshots');
      await repo.createQueryBuilder().insert().values(snapshot).updateEntity(false).execute();
      aggregate.resetSnapshotCounter();

      // Retention (keep window / min keep)
      if (aggregate.allowPruning) {
        await this.applySnapshotRetention(aggregate.aggregateId, snapshot.blockHeight, ret);
      }
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const code = (error.driverError as any)?.code;
        if (code === 'SQLITE_CONSTRAINT') {
          this.log.debug('Snapshot conflict, skipping', { args: { aggregateId: aggregate.aggregateId } });
          return;
        }
      }
      throw error;
    }
  }

  async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    const repo = this.getRepository('snapshots');
    for (const aggregateId of aggregateIds) {
      await repo
        .createQueryBuilder()
        .delete()
        .where('aggregateId = :aggregateId', { aggregateId })
        .andWhere('blockHeight > :blockHeight', { blockHeight })
        .execute();
    }
  }

  async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number, ret?: SnapshotRetention): Promise<void> {
    await this.applySnapshotRetention(aggregateId, currentBlockHeight, ret);
  }

  async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    const repo = this.getRepository(aggregateId);
    await repo
      .createQueryBuilder()
      .delete()
      .where('blockHeight < :blockHeight', { blockHeight: pruneToBlockHeight })
      .execute();
  }

  async createSnapshotAtHeight<K extends T>(model: K, blockHeight: number): Promise<SnapshotParameters> {
    const { aggregateId } = model;
    if (!aggregateId) throw new Error('Model does not have aggregateId');

    const snap = await this.findSnapshotBeforeHeight(aggregateId, blockHeight);
    if (!snap) {
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else if (snap.blockHeight < blockHeight) {
      const decomp = await deserializeSnapshot(snap, 'sqlite');
      model.fromSnapshot(decomp);
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'sqlite');
      model.fromSnapshot(decomp);
    }
    return { aggregateId, blockHeight: model.lastBlockHeight, version: model.version, payload: model.toSnapshot() };
  }

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
    const raws = await qb.getMany();
    return await Promise.all(raws.map((r: any) => deserializeToDomainEvent(aggregateId, r, 'sqlite')));
  }

  async fetchEventsForAggregates(
    aggregateIds: string[],
    options: { version?: number; blockHeight?: number; limit?: number; offset?: number } = {}
  ) {
    const results = await Promise.all(aggregateIds.map((id) => this.fetchEventsForAggregate(id, options)));
    return results.flat();
  }

  // ======== internals ========

  private getRepository<T extends ObjectLiteral = any>(entityName: string): Repository<T> {
    const meta = this.dataSource.entityMetadatasMap.get(entityName);
    if (!meta) throw new Error(`Entity with name "${entityName}" not found.`);
    return this.dataSource.getRepository<T>(meta.target);
  }

  private handleDatabaseError(error: any): void {
    if (error instanceof QueryFailedError) {
      const code = (error.driverError || {}).code;
      const message = String((error.driverError || {}).message || '');
      if (
        code === 'SQLITE_CONSTRAINT' &&
        message.includes('UNIQUE constraint failed') &&
        message.includes('.version') &&
        message.includes('.requestId')
      ) {
        this.log.debug('Idempotency: duplicate event — skipping (SQLite)');
        return;
      }
    }
  }

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
      const events = await Promise.all(raws.map((r) => deserializeToDomainEvent(model.aggregateId, r, 'sqlite')));
      await model.loadFromHistory(events);
      last = raws[raws.length - 1]!.version;
      if (raws.length < batch) break;
    }
  }

  private async applySnapshotRetention(aggregateId: string, currentHeight: number, ret?: SnapshotRetention) {
    const minKeep = ret?.minKeep ?? 2;
    const win = ret?.keepWindow ?? 0;

    // Keep last `minKeep` snapshots always; optionally keep height window
    const repo = this.getRepository<SnapshotInterface>('snapshots');

    // Find ids to keep by minKeep
    const keepRows: Array<{ id: string; blockHeight: number }> = await repo
      .createQueryBuilder('s')
      .select(['s.id AS id', 's.blockHeight AS blockHeight'])
      .where('s.aggregateId = :aggregateId', { aggregateId })
      .orderBy('s.blockHeight', 'DESC')
      .limit(minKeep)
      .getRawMany();

    const keepIds = new Set(keepRows.map((r) => r.id));
    const minHeight = win > 0 ? currentHeight - win : -Infinity;

    // Delete everything below minHeight except keepIds
    await repo
      .createQueryBuilder()
      .delete()
      .where('aggregateId = :aggregateId', { aggregateId })
      .andWhere('blockHeight < :bh', { bh: Math.max(0, minHeight) })
      .andWhere(keepIds.size ? `id NOT IN (${[...keepIds].map(() => '?').join(',')})` : '1=1', [...keepIds])
      .execute();
  }
}
