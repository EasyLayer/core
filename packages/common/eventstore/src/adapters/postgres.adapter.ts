import { Injectable } from '@nestjs/common';
import {
  DataSource,
  QueryFailedError,
  Repository,
  MoreThan,
  LessThanOrEqual,
  QueryRunner,
  ObjectLiteral,
} from 'typeorm';
import { PostgresError } from 'pg-error-enum';
import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import { AppLogger } from '@easylayer/common/logger';
import { BaseAdapter, SnapshotRetention, FIXED_OVERHEAD } from './base-adapter';
import { OutboxRowInternal, deserializeToOutboxRaw } from '../outbox.model';
import { EventDataParameters, serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { SnapshotInterface, SnapshotParameters, serializeSnapshot, deserializeSnapshot } from '../snapshots.model';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import { CompressionUtils } from '../compression';

@Injectable()
export class PostgresAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  public readonly driver = 'postgres' as const;

  constructor(
    private readonly log: AppLogger,
    private readonly dataSource: DataSource
  ) {
    super();
    if (this.dataSource.options.type !== 'postgres') {
      throw new Error('PostgresAdapter must be used with Postgres DataSource');
    }
  }

  // ======== Persist (single tx) ========

  /**
   * Persist aggregates + outbox in a single READ COMMITTED tx.
   * We generate exactly ONE Buffer per event, and reuse it for BOTH inserts.
   */
  async persistAggregatesAndOutbox(aggregates: T[]): Promise<void> {
    if (!aggregates.length) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('READ COMMITTED');

    try {
      const perAgg = new Map<string, EventDataParameters[]>(); // aggregate rows
      const outRows: Omit<OutboxRowInternal, 'id'>[] = []; // outbox rows

      for (const agg of aggregates) {
        const unsaved = agg.getUnsavedEvents();
        if (!unsaved.length) continue;

        const base = agg.version - unsaved.length;
        const rows: EventDataParameters[] = [];

        for (let i = 0; i < unsaved.length; i++) {
          const ev = unsaved[i]!;
          const ser = await serializeEventRow(ev, base + i + 1, 'postgres'); // ONE buffer created inside

          // Aggregate row (binary payload)
          rows.push({
            type: ser.type,
            payload: ser.payload, // same Buffer
            version: ser.version,
            requestId: ser.requestId,
            blockHeight: ser.blockHeight,
            isCompressed: ser.isCompressed,
            timestamp: ser.timestamp,
          });

          // Outbox row (binary payload + uncompressed byte length)
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
        await qr.release();
        return;
      }

      // Insert aggregate rows
      for (const [aggId, rows] of perAgg.entries()) {
        const repo = qr.manager.getRepository<EventDataParameters>(aggId);
        await repo.createQueryBuilder().insert().values(rows).updateEntity(false).execute();
      }

      // Insert outbox rows
      const outboxRepo = qr.manager.getRepository<OutboxRowInternal>('outbox');
      await outboxRepo.createQueryBuilder().insert().values(outRows).updateEntity(false).execute();

      // Mark events saved (whole batch is one tx)
      for (const agg of aggregates) agg.markEventsAsSaved();

      await qr.commitTransaction();
      await qr.release();
    } catch (err) {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release().catch(() => undefined);

      if (err instanceof QueryFailedError) {
        const code = (err as any).driverError?.code;
        if (
          code === PostgresError.UNIQUE_VIOLATION &&
          String((err as any).driverError?.detail || '').includes('Key (aggregateId, eventVersion)')
        ) {
          // outbox idempotency
          this.log.debug('Idempotency: duplicate outbox row — skipping (Postgres)');
          return;
        }
        if (
          code === PostgresError.UNIQUE_VIOLATION &&
          String((err as any).driverError?.detail || '').includes('Key (version, request_id)')
        ) {
          // aggregate table idempotency
          this.log.debug('Idempotency: duplicate event — skipping (Postgres)');
          return;
        }
      }
      throw err;
    }
  }

  // ======== Outbox streaming: lock -> deliver+ACK -> delete -> commit (ORDER BY timestamp,id) ========
  async fetchDeliverAckChunk(
    wireBudgetBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('READ COMMITTED');

    try {
      const idRows = (await qr.manager.query(
        `
        WITH ordered AS (
          SELECT id,
                "payload_uncompressed_bytes" AS ulen
          FROM outbox
          ORDER BY "timestamp", id
        ),
        accum AS (
          SELECT id,
                SUM(ulen + $2) OVER (ORDER BY id) AS run
          FROM ordered
        )
        SELECT id
        FROM accum
        WHERE run <= $1
      `,
        [wireBudgetBytes, FIXED_OVERHEAD]
      )) as Array<{ id: number }>;

      if (idRows.length === 0) {
        await qr.commitTransaction();
        await qr.release();
        return 0;
      }

      const ids = idRows.map((r) => r.id);

      const rows = (await qr.manager.query(
        `
        SELECT id, "aggregateId", "eventType", "eventVersion", "requestId",
              "blockHeight", payload, "isCompressed", "timestamp",
              "payload_uncompressed_bytes" AS ulen
        FROM outbox
        WHERE id = ANY($1)
        FOR UPDATE SKIP LOCKED
        ORDER BY "timestamp", id
      `,
        [ids]
      )) as Array<{
        id: number;
        aggregateId: string;
        eventType: string;
        eventVersion: number;
        requestId: string;
        blockHeight: number;
        payload: Buffer;
        isCompressed: boolean;
        timestamp: number;
        ulen: number;
      }>;

      if (rows.length === 0) {
        await qr.commitTransaction();
        await qr.release();
        return 0;
      }

      const events: WireEventRecord[] = [];
      let budget = wireBudgetBytes;

      for (const r of rows) {
        const rowBytes = FIXED_OVERHEAD + Number(r.ulen);
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

        budget -= Math.max(0, rowBytes);
      }

      if (events.length === 0) {
        await qr.commitTransaction();
        await qr.release();
        return 0;
      }

      // We send the batch and wait for ACK
      await deliver(events);

      // Remove ACK'ed rows in the same transaction
      await qr.manager.query(`DELETE FROM outbox WHERE id = ANY($1)`, [ids]);

      await qr.commitTransaction();
      await qr.release();
      return events.length;
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      await qr.release().catch(() => undefined);
      throw e;
    }
  }

  // ======== Rollback (single tx) ========

  async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    await this.runInTx(async (qr) => {
      // events
      for (const id of aggregateIds) {
        await qr.manager.query(`DELETE FROM "${id}" WHERE "blockHeight" > $1`, [blockHeight]);
      }
      // snapshots
      await qr.manager.query(`DELETE FROM "snapshots" WHERE "aggregateId" = ANY($1) AND "blockHeight" > $2`, [
        aggregateIds,
        blockHeight,
      ]);
      // outbox
      await qr.manager.query(`DELETE FROM "outbox" WHERE "aggregateId" = ANY($1) AND "blockHeight" > $2`, [
        aggregateIds,
        blockHeight,
      ]);
    });
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
      const decomp = await deserializeSnapshot(snap, 'postgres');
      model.fromSnapshot(decomp);
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'postgres');
      model.fromSnapshot(decomp);
    }
  }

  // ======== Reads / Snapshots ========

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
      const events = await Promise.all(raws.map((r) => deserializeToDomainEvent(model.aggregateId, r, 'postgres')));
      await model.loadFromHistory(events);
      last = raws[raws.length - 1]!.version;
      if (raws.length < batch) break;
    }
  }

  async createSnapshot(aggregate: T, ret?: SnapshotRetention): Promise<void> {
    if (!aggregate.canMakeSnapshot()) return;
    try {
      const snapshot = await serializeSnapshot(aggregate as any, 'postgres');
      const repo = this.getRepository('snapshots');
      await repo.createQueryBuilder().insert().values(snapshot).updateEntity(false).execute();
      aggregate.resetSnapshotCounter();

      if (aggregate.allowPruning) {
        await this.applySnapshotRetention(aggregate.aggregateId, snapshot.blockHeight, ret);
      }
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const code = (error.driverError as any)?.code;
        if (code === PostgresError.UNIQUE_VIOLATION) {
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
      const decomp = await deserializeSnapshot(snap, 'postgres');
      model.fromSnapshot(decomp);
      await this.applyEventsToAggregateAtHeight(model, blockHeight);
    } else {
      const decomp = await deserializeSnapshot(snap, 'postgres');
      model.fromSnapshot(decomp);
    }
    return { aggregateId, blockHeight: model.lastBlockHeight, version: model.version, payload: model.toSnapshot() };
  }

  async fetchEventsForAggregate(
    aggregateId: string,
    options: { version?: number; blockHeight?: number; limit?: number; offset?: number } = {}
  ): Promise<DomainEvent[]> {
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
    return await Promise.all(raws.map((r: any) => deserializeToDomainEvent(aggregateId, r, 'postgres')));
  }

  async fetchEventsForAggregates(
    aggregateIds: string[],
    options: { version?: number; blockHeight?: number; limit?: number; offset?: number } = {}
  ): Promise<DomainEvent[]> {
    const results = await Promise.all(aggregateIds.map((id) => this.fetchEventsForAggregate(id, options)));
    return results.flat();
  }

  // ======== internals ========

  private async runInTx<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('READ COMMITTED');
    try {
      const res = await fn(qr);
      await qr.commitTransaction();
      return res;
    } catch (err) {
      await qr.rollbackTransaction();
      this.handleDatabaseError(err as any);
      throw err;
    } finally {
      await qr.release();
    }
  }

  private getRepository<T extends ObjectLiteral = any>(entityName: string): Repository<T> {
    const meta = this.dataSource.entityMetadatasMap.get(entityName);
    if (!meta) throw new Error(`Entity with name "${entityName}" not found.`);
    return this.dataSource.getRepository<T>(meta.target);
  }

  private handleDatabaseError(error: any): void {
    if (error instanceof QueryFailedError) {
      const code = (error.driverError as any)?.code as string | undefined;
      const constraint = (error as any)?.constraint as string | undefined;

      if (code === PostgresError.UNIQUE_VIOLATION) {
        if (constraint === 'UQ_outbox_aggregate_version') {
          // this.log.debug('Idempotency: duplicate outbox row — skipping (Postgres)');
          return;
        }
        if (constraint === 'UQ_aggregate_blockheight') {
          // this.log.debug('Snapshot conflict — skipping (Postgres)');
          return;
        }
        if (constraint && /UQ_.*_version_requestId/.test(constraint)) {
          // this.log.debug('Idempotency: duplicate event — skipping (Postgres)');
          return;
        }
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
      const events = await Promise.all(raws.map((r) => deserializeToDomainEvent(model.aggregateId, r, 'postgres')));
      await model.loadFromHistory(events);
      last = raws[raws.length - 1]!.version;
      if (raws.length < batch) break;
    }
  }

  private async applySnapshotRetention(aggregateId: string, currentHeight: number, ret?: SnapshotRetention) {
    const minKeep = ret?.minKeep ?? 2;
    const win = ret?.keepWindow ?? 0;

    const repo = this.getRepository<SnapshotInterface>('snapshots');

    const keepRows: Array<{ id: string; blockHeight: number }> = await repo
      .createQueryBuilder('s')
      .select(['s.id AS id', 's.blockHeight AS blockHeight'])
      .where('s.aggregateId = :aggregateId', { aggregateId })
      .orderBy('s.blockHeight', 'DESC')
      .limit(minKeep)
      .getRawMany();

    const keepIds = new Set(keepRows.map((r) => r.id));
    const minHeight = win > 0 ? currentHeight - win : -Infinity;

    await repo
      .createQueryBuilder()
      .delete()
      .where('aggregateId = :aggregateId', { aggregateId })
      .andWhere('blockHeight < :bh', { bh: Math.max(0, minHeight) })
      .andWhere(keepIds.size ? `id NOT IN (${[...keepIds].map(() => '?').join(',')})` : '1=1', [...keepIds])
      .execute();
  }
}
