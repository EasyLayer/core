import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, Repository, MoreThan, LessThanOrEqual, ObjectLiteral } from 'typeorm';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseAdapter, SnapshotRetention } from './base-adapter';
import { OutboxRowInternal } from '../outbox.model';
import { EventDataParameters, serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { SnapshotInterface, SnapshotParameters, serializeSnapshot, deserializeSnapshot } from '../snapshots.model';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import { CompressionUtils } from '../compression';

const FIXED_OVERHEAD = 160;

@Injectable()
export class BrowserSqljsAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  public readonly driver = 'sqljs' as const;
  private sqljsBatchSize = 999;

  private lastSeenTsUs = 0;
  private lastSeenId = 0;

  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource
  ) {
    super();
    if (this.dataSource.options.type !== 'sqljs') {
      throw new Error('BrowserSqljsAdapter must be used with sqljs DataSource');
    }
  }

  // ======== Persist (single tx; short PRAGMA) ========

  /**
   * Persist aggregates + outbox in a single transaction.
   * We create ONE Buffer per event (optionally compressed) and use it for BOTH:
   *  - aggregate tables (payload: BLOB)
   *  - outbox table  (payload: BLOB)
   * No base64, no duplicate buffers.
   */
  async persistAggregatesAndOutbox(aggregates: T[]): Promise<void> {
    if (!aggregates.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    // Optional PRAGMAs to speed up bulk writes
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
          const ser = await serializeEventRow(ev, base + i + 1, 'sqljs'); // ONE buffer created inside

          // aggregate row (binary payload)
          rows.push({
            type: ser.type,
            payload: ser.payloadAggregate, // same Buffer
            version: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            isCompressed: ser.isCompressed,
          });

          // outbox row (binary payload, plus uncompressed length)
          outRows.push({
            aggregateId: agg.aggregateId,
            eventType: ser.type,
            eventVersion: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            payload: ser.payloadOutbox, // same Buffer
            timestamp: ev.timestamp ?? Date.now(),
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

      // Insert aggregate rows in batches
      for (const [aggId, rows] of perAgg.entries()) {
        const repo = qr.manager.getRepository<EventDataParameters>(aggId);
        for (let i = 0; i < rows.length; i += this.sqljsBatchSize) {
          const batch = rows.slice(i, i + this.sqljsBatchSize);
          await repo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // Insert outbox rows
      const outboxRepo = qr.manager.getRepository<OutboxRowInternal>('outbox');
      await outboxRepo.createQueryBuilder().insert().values(outRows).updateEntity(false).execute();

      // Mark events saved on aggregates (entire batch is one tx)
      for (const agg of aggregates) agg.markEventsAsSaved();

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      // Swallow idempotent unique conflicts if any; rethrow others
      if (!(err instanceof QueryFailedError)) throw err;
      throw err;
    } finally {
      await qr.query('PRAGMA foreign_keys = ON;');
      await qr.release();
    }
  }

  // ======== Outbox streaming: read in ORDER BY (timestamp,id) -> ACK -> IMMEDIATE delete ========
  async fetchDeliverAckChunk(
    wireBudgetBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    const ids: number[] = [];
    const events: WireEventRecord[] = [];
    let budget = wireBudgetBytes;

    while (true) {
      // Important: the condition on the tuple is via OR, so that it works the same in both SQLite and PG
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
        blockHeight: number;
        payload: Buffer;
        isCompressed: number | boolean;
        ulen: number;
        timestamp: number;
      }>;

      if (rows.length === 0) break;

      const r = rows[0]!;
      // Shift the watermark to the selected line (strict progress by (ts,id))
      this.lastSeenTsUs = Number(r.timestamp);
      this.lastSeenId = Number(r.id);

      const compressed = !!r.isCompressed;
      const jsonStr = compressed ? await CompressionUtils.decompressAny(r.payload) : r.payload.toString('utf8');

      const rowBytes = FIXED_OVERHEAD + Number(r.ulen);
      if (events.length > 0 && rowBytes > budget) break;

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
      budget -= Math.max(0, rowBytes);
    }

    if (events.length === 0) return 0;

    // We send one batch and wait for a single ACK
    await deliver(events);

    // Remove ACK'ed ids
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      await qr.manager.query(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }

    return events.length;
  }

  // ======== Rollback ========

  async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    try {
      // Delete events and snapshots above height per aggregate
      for (const id of aggregateIds) {
        await qr.query('BEGIN');
        try {
          await qr.manager.query(`DELETE FROM "${id}" WHERE blockHeight > ?`, [blockHeight]);
          await qr.commitTransaction();
        } catch {
          await qr.rollbackTransaction().catch(() => undefined);
          throw new Error(`Failed to delete events for ${id}`);
        }

        await qr.query('BEGIN');
        try {
          await qr.manager.query(`DELETE FROM snapshots WHERE "aggregateId" = ? AND "blockHeight" > ?`, [
            id,
            blockHeight,
          ]);
          await qr.commitTransaction();
        } catch {
          await qr.rollbackTransaction().catch(() => undefined);
          throw new Error(`Failed to delete snapshots for ${id}`);
        }
      }

      // Outbox cleanup for affected aggregates
      await qr.query('BEGIN');
      try {
        await qr.manager.query(
          `DELETE FROM outbox WHERE "aggregateId" IN (${aggregateIds.map(() => '?').join(',')}) AND "blockHeight" > ?`,
          [...aggregateIds, blockHeight]
        );
        await qr.commitTransaction();
      } catch {
        await qr.rollbackTransaction().catch(() => undefined);
        throw new Error(`Failed to delete outbox rows`);
      }
    } finally {
      await qr.release();
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
      const decomp = await deserializeSnapshot(snap, 'sqljs');
      model.fromSnapshot(decomp);
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'sqljs');
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
      const events = await Promise.all(raws.map((r) => deserializeToDomainEvent(model.aggregateId, r, 'sqljs')));
      await model.loadFromHistory(events);
      last = raws[raws.length - 1]!.version;
      if (raws.length < batch) break;
    }
  }

  async createSnapshot(aggregate: T, ret?: SnapshotRetention): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;
    try {
      const snapshot = await serializeSnapshot(aggregate as any, 'sqljs');
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
      const decomp = await deserializeSnapshot(snap, 'sqljs');
      model.fromSnapshot(decomp);
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'sqljs');
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
    return await Promise.all(raws.map((r: any) => deserializeToDomainEvent(aggregateId, r, 'sqljs')));
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
