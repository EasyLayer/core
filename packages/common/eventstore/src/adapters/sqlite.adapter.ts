import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, Repository, MoreThan, LessThanOrEqual, ObjectLiteral } from 'typeorm';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseAdapter } from './base-adapter';
import { OutboxRowInternal } from '../outbox.model';
import { EventDataParameters, serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { SnapshotInterface, SnapshotParameters, serializeSnapshot, deserializeSnapshot } from '../snapshots.model';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import { CompressionUtils } from '../compression.utils';

const FIXED_OVERHEAD = 160;

@Injectable()
export class SqliteEventStoreAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  public readonly driver = 'sqlite' as const;
  private sqliteBatchSize = 999;
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

  // ======== Persist (single tx; PRAGMA optional) ========

  async persistAggregatesAndOutbox(aggregates: T[]): Promise<void> {
    if (!aggregates.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    await qr.query('PRAGMA foreign_keys = OFF;');
    await qr.query('PRAGMA journal_mode = WAL;');
    await qr.query('PRAGMA synchronous = NORMAL;');
    await qr.query('PRAGMA temp_store = MEMORY;');
    await qr.query('PRAGMA mmap_size = 67108864;');
    await qr.query('PRAGMA cache_size = -64000;');
    await qr.query('PRAGMA locking_mode = EXCLUSIVE;');
    await qr.query('PRAGMA busy_timeout = 3000;');
    await qr.query('PRAGMA journal_size_limit = 67108864;');

    await qr.startTransaction(); // BEGIN (DEFERRED)

    try {
      const perAgg = new Map<string, EventDataParameters[]>();
      const flat: Array<{ aggId: string; row: EventDataParameters; ts: number }> = [];

      for (const agg of aggregates) {
        const unsaved = agg.getUnsavedEvents();
        if (!unsaved.length) continue;

        const base = agg.version - unsaved.length;
        const rows: EventDataParameters[] = [];
        for (let i = 0; i < unsaved.length; i++) {
          const ev = unsaved[i]!;
          const ser = await serializeEventRow(ev, base + i + 1, 'sqlite');
          rows.push(ser);
          flat.push({ aggId: agg.aggregateId, row: ser, ts: ev.timestamp ?? Date.now() });
        }
        perAgg.set(agg.aggregateId, rows);
      }

      if (!flat.length) {
        await qr.commitTransaction();
        return;
      }
      flat.sort((a, b) => a.ts - b.ts);

      // insert aggregates in batches
      for (const [aggId, rows] of perAgg.entries()) {
        const repo = qr.manager.getRepository<EventDataParameters>(aggId);
        for (let i = 0; i < rows.length; i += this.sqliteBatchSize) {
          const batch = rows.slice(i, i + this.sqliteBatchSize);
          await repo.createQueryBuilder().insert().values(batch).updateEntity(false).execute();
        }
      }

      // insert outbox (binary blob + uncompressed bytes)
      const outboxRepo = qr.manager.getRepository<OutboxRowInternal>('outbox');
      const outRows = flat.map(({ aggId, row, ts }) => ({
        aggregateId: aggId,
        eventType: row.type,
        eventVersion: row.version,
        requestId: row.requestId,
        blockHeight: row.blockHeight,
        payload: (row as any).payloadForOutboxBuffer as Buffer,
        timestamp: ts,
        isCompressed: row.isCompressed ?? false,
        payload_uncompressed_bytes: (row as any).payloadUncompressedBytes as number,
      }));
      await outboxRepo.createQueryBuilder().insert().values(outRows).updateEntity(false).execute();

      for (const agg of aggregates) agg.markEventsAsSaved();
      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      this.handleDatabaseError(err as any);
      throw err;
    } finally {
      await qr.query('PRAGMA foreign_keys = ON;');
      await qr.release();
    }
  }

  // ======== Streaming (no long read tx; IMMEDIATE on delete) ========

  async fetchDeliverAckChunk(
    wireBudgetBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    const ids: number[] = [];
    const events: WireEventRecord[] = [];
    let budget = wireBudgetBytes;

    // read 1-by-1 without read tx
    while (true) {
      const rows = (await this.dataSource.query(
        `SELECT id, aggregateId, eventType, eventVersion, requestId, blockHeight,
                payload, isCompressed, payload_uncompressed_bytes AS ulen, timestamp
         FROM outbox
         WHERE id > ?
         ORDER BY id
         LIMIT 1`,
        [this.lastSeenId]
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
      this.lastSeenId = Number(r.id); // watermark moves forward regardless

      const compressedFlag = !!r.isCompressed;
      const jsonStr = compressedFlag
        ? await CompressionUtils.decompressAny(r.payload)
        : Buffer.isBuffer(r.payload)
          ? r.payload.toString('utf8')
          : String(r.payload);

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

    await deliver(events);

    // short write tx to delete exactly acked ids
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN IMMEDIATE');
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

  // ======== Optional fallback ========
  async toWireEvents(rows: OutboxRowInternal[]): Promise<WireEventRecord[]> {
    return Promise.all(
      rows.map(async (r) => ({
        modelName: r.aggregateId,
        eventType: r.eventType,
        eventVersion: Number(r.eventVersion),
        requestId: r.requestId,
        blockHeight: Number(r.blockHeight),
        payload: r.isCompressed ? await CompressionUtils.decompressAny(r.payload) : r.payload.toString('utf8'),
        timestamp: Number(r.timestamp),
      }))
    );
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

  async createSnapshot(aggregate: T): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;
    try {
      const snapshot = await serializeSnapshot(aggregate as any, 'sqlite');
      const repo = this.getRepository('snapshots');
      await repo.createQueryBuilder().insert().values(snapshot).updateEntity(false).execute();
      aggregate.resetSnapshotCounter();
      if (aggregate.allowPruning) {
        await this.pruneOldSnapshots(aggregate.aggregateId, snapshot.blockHeight);
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
        .andWhere('blockHeight >= :blockHeight', { blockHeight })
        .execute();
    }
  }

  async pruneOldSnapshots(aggregateId: string, currentBlockHeight: number): Promise<void> {
    try {
      const repo = this.getRepository('snapshots');
      await repo
        .createQueryBuilder()
        .delete()
        .where('aggregateId = :aggregateId', { aggregateId })
        .andWhere('blockHeight < :blockHeight', { blockHeight: currentBlockHeight })
        .execute();
    } catch (error) {
      this.log.debug('Error pruning old snapshots', { args: { aggregateId, currentBlockHeight, error } });
    }
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

  // internals
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
}
