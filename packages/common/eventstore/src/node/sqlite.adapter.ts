import { Mutex } from 'async-mutex';
import type { DomainEvent } from '@easylayer/common/cqrs';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import type {
  FindEventsOptions,
  EventReadRow,
  SnapshotDataModel,
  EventDataModel,
  SnapshotReadRow,
  SnapshotOptions,
  PersistAggregatesOptions,
} from '../core';
import {
  assertFullOutboxAck,
  BaseAdapter,
  type OutboxDeliveryAck,
  type OutboxDeliveryChunkInfo,
  type OutboxDeliveryChunkObserver,
} from '../core';
import { toEventDataModel, toDomainEvent, toEventReadRow } from './event-data.serialize';
import { toWireEventRecord } from './outbox.deserialize';
import { toSnapshotDataModel, toSnapshotReadRow, toSnapshotParsedPayload } from './snapshot.serialize';
import { validateAggregateId } from './entities';
import { applyDefaultSqlitePragmas } from './node-utils';
import type { SqliteFileManager } from './sqlite-file-manager';

function summarizeOutboxRows(
  rows: Array<{
    id: string;
    aggregateId: string;
    eventType: string;
    eventVersion: number;
    requestId: string;
    blockHeight: number | null;
  }>
): OutboxDeliveryChunkInfo {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const distinctAggregateIds = Array.from(new Set(rows.map((r) => r.aggregateId))).slice(0, 10);
  const distinctEventTypes = Array.from(new Set(rows.map((r) => r.eventType))).slice(0, 10);

  return {
    outboxIds: rows.map((r) => r.id),
    eventCount: rows.length,
    firstOutboxId: first?.id,
    lastOutboxId: last?.id,
    firstAggregateId: first?.aggregateId,
    lastAggregateId: last?.aggregateId,
    firstEventType: first?.eventType,
    lastEventType: last?.eventType,
    firstEventVersion: first?.eventVersion,
    lastEventVersion: last?.eventVersion,
    firstRequestId: first?.requestId,
    lastRequestId: last?.requestId,
    firstBlockHeight: first?.blockHeight ?? null,
    lastBlockHeight: last?.blockHeight ?? null,
    distinctAggregateIds,
    distinctEventTypes,
  };
}

/**
 * SQLite adapter (Node sqlite).
 *
 * Key points:
 * - Never calls aggregate.apply(); only aggregate.loadFromHistory().
 * - Uses project serializers/deserializers exclusively (no ad-hoc JSON ops).
 * - Payload is stored as BLOB in both per-aggregate tables and the outbox.
 * - Outbox ordering is by client-generated BIGINT PRIMARY KEY "id" (monotonic).
 * - Transactions use BEGIN IMMEDIATE to shorten the lock window and avoid writer stalls.
 * - Chunk sizing for delivery is computed locally from transport cap.
 *
 * File-rotation mode (when fileManager is provided):
 * - database config points to a directory, not a single file.
 * - On each snapshot at an irreversible height, SqliteFileManager.rotate() is called:
 *   the current file is archived, a new current.sqlite3 is created with tail data copied over.
 * - All reads always go to current.sqlite3 only — archived files are never queried.
 *   If allowPruning=true archived files are deleted; the user accepts historical data is gone.
 * - lastSeenId (delivery watermark) is never reset on rotation — outbox rows are copied
 *   with their original ids, so the watermark remains valid. [P3]
 */
export class SqliteAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  private writeLock = new Mutex();
  private deliverLock = new Mutex();
  // Delivery watermark: last delivered outbox id (strictly increasing).
  private lastSeenId = 0n;

  // Deletion chunk size for large IN () lists (SQLite parameter limit is large; 10k is safe and fast).
  private static readonly DELETE_ID_CHUNK = 10_000;

  // Prefetch tuning for delivery scanning (ordered by id).
  private static readonly FIXED_OVERHEAD = 256; // wire envelope approx per event (bytes)
  private static readonly AVG_EVENT_BYTES_GUESS = 8 * 1024; // coarse avg of uncompressed JSON
  private static readonly MIN_PREFETCH_ROWS = 256;
  private static readonly MAX_PREFETCH_ROWS = 8_192;

  // null in single-file mode (no directory config / snapshots disabled).
  private fileManager: SqliteFileManager | null;

  constructor(dataSource: any, fileManager: SqliteFileManager | null = null) {
    super(dataSource);
    this.fileManager = fileManager;
  }

  /**
   * Apply standard SQLite PRAGMAs.
   * Extracted to applyDefaultSqlitePragmas() in node-utils so it can be reused
   * when initializing new files after rotation.
   */
  public async onModuleInit(): Promise<void> {
    await applyDefaultSqlitePragmas(this.dataSource);
  }

  /**
   * Release the SQLite exclusive lock on app close.
   * Without this, PRAGMA locking_mode=EXCLUSIVE keeps the file locked after
   * NestJS shuts down, causing SQLITE_BUSY in any subsequent connection
   * (e.g. test helpers that open the DB after the app context closes).
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.dataSource?.isInitialized) {
      await this.dataSource.destroy();
    }
  }

  // ─────────────────────────────── WRITE PATH ───────────────────────────────

  /**
   * Persist unsaved events of each aggregate into:
   *   1) per-aggregate event table (BLOB payload)
   *   2) outbox (BLOB payload) — with client-generated monotonic id
   *
   * Returns the inserted outbox ids and raw events for local system emission only. Remote delivery drains persisted outbox rows.
   * NOTE: firstTs/lastTs are returned for compatibility; adapter uses id-based checks internally.
   */
  public async persistAggregatesAndOutbox(
    aggregates: T[],
    options: PersistAggregatesOptions
  ): Promise<{
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }> {
    return this.writeLock.runExclusive(async () => {
      const writeOutbox = options.writeOutbox;
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE');

      const outboxIds: string[] = [];
      const rawEvents: WireEventRecord[] = [];

      let firstIdBn: bigint | null = null;
      let lastIdBn: bigint | null = null;

      let firstTs = Number.MAX_SAFE_INTEGER;
      let lastTs = 0;

      try {
        for (const agg of aggregates) {
          const table = agg.aggregateId;
          if (!table) throw new Error('Aggregate has no aggregateId');
          validateAggregateId(table);

          const unsaved: DomainEvent[] = [...agg.getUnsavedEvents()];
          if (unsaved.length === 0) continue;

          const startVersion = agg.version - unsaved.length + 1;

          for (let i = 0; i < unsaved.length; i++) {
            const ev = unsaved[i] as DomainEvent;
            const version = startVersion + i;

            const row = await toEventDataModel(ev, version, 'sqlite');

            const newId = writeOutbox ? this.idGen.next(ev.timestamp!) : null;

            await qr.manager.query(
              `INSERT OR IGNORE INTO "${table}"
                ("version","requestId","type","payload","blockHeight","isCompressed","timestamp")
              VALUES (?,?,?,?,?,?,?)`,
              [
                row.version,
                row.requestId,
                row.type,
                row.payload,
                row.blockHeight,
                row.isCompressed ? 1 : 0,
                row.timestamp,
              ]
            );

            if (writeOutbox && newId !== null) {
              await qr.manager.query(
                `INSERT OR IGNORE INTO "outbox"
                  ("id","aggregateId","eventType","eventVersion","requestId","blockHeight","payload","isCompressed","timestamp","uncompressedBytes")
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [
                  newId.toString(),
                  table,
                  row.type,
                  row.version,
                  row.requestId,
                  row.blockHeight,
                  row.payload,
                  row.isCompressed ? 1 : 0,
                  row.timestamp,
                  row.uncompressedBytes,
                ]
              );

              if (firstIdBn === null || newId < firstIdBn) firstIdBn = newId;
              if (lastIdBn === null || newId > lastIdBn) lastIdBn = newId;
              outboxIds.push(newId.toString());
            }

            if (ev.timestamp! < firstTs) firstTs = ev.timestamp!;
            if (ev.timestamp! > lastTs) lastTs = ev.timestamp!;

            rawEvents.push(
              await toWireEventRecord({
                aggregateId: table,
                eventType: row.type,
                eventVersion: row.version,
                requestId: row.requestId,
                blockHeight: row.blockHeight,
                payload: row.payload,
                isCompressed: !!row.isCompressed,
                timestamp: ev.timestamp!,
              })
            );
          }
        }

        await qr.query('COMMIT');

        for (const agg of aggregates) {
          agg.markEventsAsSaved();
        }

        const firstId = firstIdBn ? String(firstIdBn) : '0';
        const lastId = lastIdBn ? String(lastIdBn) : '0';
        if (outboxIds.length === 0) {
          firstTs = 0;
          lastTs = 0;
        }

        return { insertedOutboxIds: outboxIds, firstTs, firstId, lastTs, lastId, rawEvents };
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release();
      }
    });
  }

  public async deleteOutboxByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.writeLock.runExclusive(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE');
      try {
        const step = SqliteAdapter.DELETE_ID_CHUNK;
        for (let i = 0; i < ids.length; i += step) {
          const chunk = ids.slice(i, i + step);
          const placeholders = chunk.map(() => '?').join(',');
          await qr.manager.query(`DELETE FROM "outbox" WHERE id IN (${placeholders})`, chunk);
        }
        await qr.query('COMMIT');
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release();
      }
    });
  }

  public async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) return;
    await this.writeLock.runExclusive(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE');
      try {
        for (const id of aggregateIds) {
          validateAggregateId(id);
          await qr.manager.query(`DELETE FROM "${id}" WHERE "blockHeight" > ?`, [blockHeight]);
        }

        const placeholders = aggregateIds.map(() => '?').join(',');
        await qr.manager.query(
          `DELETE FROM "snapshots" WHERE "blockHeight" > ? AND "aggregateId" IN (${placeholders})`,
          [blockHeight, ...aggregateIds]
        );

        await qr.manager.query(`DELETE FROM "outbox"`);

        await qr.query('COMMIT');

        this.lastSeenId = 0n;
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release();
      }
    });
  }

  // ─────────────────────────────── BACKLOG TESTS ───────────────────────────────

  public async hasBacklogBefore(_ts: number, id: string): Promise<boolean> {
    if (!/^\d+$/.test(String(id))) throw new Error(`Invalid outbox id "${id}"`);
    const rows = await this.dataSource.query(`SELECT 1 FROM "outbox" WHERE id < CAST(? AS INTEGER) LIMIT 1`, [
      String(id),
    ]);
    return rows.length > 0;
  }

  public async hasPendingAfterId(lastId: string): Promise<boolean> {
    if (!/^\d+$/.test(String(lastId))) throw new Error(`Invalid outbox id "${lastId}"`);
    const rows = await this.dataSource.query(`SELECT 1 FROM "outbox" WHERE id > CAST(? AS INTEGER) LIMIT 1`, [
      String(lastId),
    ]);
    return rows.length > 0;
  }

  // ─────────────────────────────── DELIVER / ACK ───────────────────────────────

  public async fetchDeliverAckChunk(
    transportCapBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<OutboxDeliveryAck>,
    observe?: OutboxDeliveryChunkObserver
  ): Promise<number> {
    return this.deliverLock.runExclusive(async () => {
      const wantRows = Math.max(1, Math.floor(transportCapBytes / SqliteAdapter.AVG_EVENT_BYTES_GUESS));
      const scanLimit = Math.max(SqliteAdapter.MIN_PREFETCH_ROWS, Math.min(SqliteAdapter.MAX_PREFETCH_ROWS, wantRows));

      const rows = (await this.dataSource.query(
        `SELECT CAST(id AS TEXT) AS id,
                "aggregateId"  AS "aggregateId",
                "eventType"    AS "eventType",
                "eventVersion" AS "eventVersion",
                "requestId"    AS "requestId",
                "blockHeight"  AS "blockHeight",
                "payload"      AS "payload",
                "isCompressed" AS "isCompressed",
                "timestamp"    AS "timestamp",
                "uncompressedBytes" as ulen
         FROM "outbox"
         WHERE id > CAST(? AS INTEGER)
         ORDER BY id ASC
         LIMIT ${scanLimit}`,
        [String(this.lastSeenId)]
      )) as Array<{
        id: string;
        aggregateId: string;
        eventType: string;
        eventVersion: number;
        requestId: string;
        blockHeight: number | null;
        payload: Buffer;
        isCompressed: number | boolean;
        timestamp: number;
        ulen: number;
      }>;

      if (rows.length === 0) return 0;

      const accepted: typeof rows = [];
      let running = 0;

      for (const r of rows) {
        const eventBytes =
          Number.isFinite(Number(r.ulen)) && Number(r.ulen) > 0
            ? Number(r.ulen)
            : Buffer.byteLength(r.payload ?? Buffer.alloc(0));
        const add = SqliteAdapter.FIXED_OVERHEAD + eventBytes;
        if (accepted.length === 0) {
          accepted.push(r);
          running += add;
          continue;
        }
        if (running + add > transportCapBytes) break;
        accepted.push(r);
        running += add;
      }

      const chunkInfo = summarizeOutboxRows(accepted);
      observe?.({ phase: 'selected', chunk: chunkInfo, watermarkBefore: String(this.lastSeenId) });

      const events: WireEventRecord[] = new Array(accepted.length);
      for (let i = 0; i < accepted.length; i++) {
        const r = accepted[i]!;
        events[i] = await toWireEventRecord({
          aggregateId: r.aggregateId,
          eventType: r.eventType,
          eventVersion: r.eventVersion,
          requestId: r.requestId,
          blockHeight: r.blockHeight!,
          payload: r.payload,
          isCompressed: !!r.isCompressed,
          timestamp: r.timestamp,
        });
      }

      const last = accepted[accepted.length - 1]!;
      const nextId = BigInt(last.id);

      const ack = await deliver(events);
      assertFullOutboxAck(ack, events.length);

      const deleteStartedAt = Date.now();
      const watermarkBefore = String(this.lastSeenId);
      observe?.({ phase: 'delete-started', chunk: chunkInfo, watermarkBefore });

      await this.writeLock.runExclusive(async () => {
        const ids = accepted.map((r) => r.id);
        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.query('BEGIN IMMEDIATE');
        try {
          const step = SqliteAdapter.DELETE_ID_CHUNK;
          for (let i = 0; i < ids.length; i += step) {
            const chunk = ids.slice(i, i + step);
            const placeholders = chunk.map(() => 'CAST(? AS INTEGER)').join(',');
            await qr.manager.query(`DELETE FROM "outbox" WHERE id IN (${placeholders})`, chunk);
          }
          await qr.query('COMMIT');
          this.lastSeenId = nextId;
          const watermarkAfter = String(this.lastSeenId);
          observe?.({
            phase: 'delete-committed',
            chunk: chunkInfo,
            deleteMs: Date.now() - deleteStartedAt,
            watermarkBefore,
            watermarkAfter,
          });
          observe?.({ phase: 'watermark-advanced', chunk: chunkInfo, watermarkBefore, watermarkAfter });
        } catch (e) {
          await qr.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          await qr.release();
        }
      });

      return events.length;
    });
  }

  public advanceWatermark(lastId: string): void {
    const id = BigInt(lastId);
    if (id > this.lastSeenId) this.lastSeenId = id;
  }

  // ─────────────────────────────── SNAPSHOTS ───────────────────────────────

  /**
   * Persist aggregate state as a snapshot, then optionally rotate the SQLite file.
   *
   * Rotation occurs only when:
   *  - fileManager is set (directory mode)
   *  - irreversibleHeight is provided by the crawler
   *  - snapshot.blockHeight <= irreversibleHeight (block is finalized)
   *
   * After rotation, this.dataSource is replaced atomically.
   * lastSeenId is NOT reset — see [P3] in SqliteFileManager.
   */
  public async createSnapshot(aggregate: T, opts: SnapshotOptions, irreversibleHeight?: number): Promise<void> {
    validateAggregateId(aggregate.aggregateId);
    const row = await toSnapshotDataModel(aggregate, 'sqlite');

    await this.writeLock.runExclusive(async () => {
      // 1. Insert snapshot into current file (same as before).
      await this.dataSource.query(
        `INSERT OR IGNORE INTO "snapshots" ("aggregateId","blockHeight","version","payload","isCompressed")
         VALUES (?,?,?,?,?)`,
        [row.aggregateId, row.blockHeight, row.version, row.payload, row.isCompressed ? 1 : 0]
      );

      // 2. Rotate if conditions are met.
      if (this.fileManager && irreversibleHeight !== undefined && row.blockHeight <= irreversibleHeight) {
        const { newDataSource } = await this.fileManager.rotate(this.dataSource, row.blockHeight);

        // Replace DataSource atomically (JS is single-threaded; assignment is atomic).
        // Assign the new DS before doing anything else so this.dataSource is never
        // in a destroyed state from concurrent async reads.
        this.dataSource = newDataSource;

        // lastSeenId is intentionally NOT modified here. [P3]
      }
    });

    // 3. Pruning — use global allowPruning from opts (set by crawler config), not per-aggregate flag.
    //    All models share the same SQLite files, so pruning must be all-or-nothing.
    const allow = opts.allowPruning === true;
    if (allow) {
      await this.pruneOldSnapshots(row.aggregateId, row.blockHeight, opts);
      // In rotation mode, also prune old archived files.
      if (this.fileManager) {
        this.fileManager.pruneArchivedFiles(row.blockHeight, opts.minKeep, opts.keepWindow);
      }
    }
  }

  /** Return latest snapshot (full DB row) for aggregateId. */
  public async findLatestSnapshot(aggregateId: string): Promise<SnapshotDataModel | null> {
    validateAggregateId(aggregateId);
    const rows = await this.dataSource.query(
      `SELECT "id","aggregateId","blockHeight","version","payload","isCompressed","createdAt"
       FROM "snapshots"
       WHERE "aggregateId" = ?
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [aggregateId]
    );
    if (rows.length === 0) return null;
    return this._mapSnapshotRow(rows[0]);
  }

  /** Return latest snapshot ≤ given height from current.sqlite3 only. */
  public async findLatestSnapshotBeforeHeight(aggregateId: string, height: number): Promise<SnapshotDataModel | null> {
    validateAggregateId(aggregateId);

    const rows = await this.dataSource.query(
      `SELECT "id","aggregateId","blockHeight","version","payload","isCompressed","createdAt"
       FROM "snapshots"
       WHERE "aggregateId" = ? AND "blockHeight" <= ?
       ORDER BY "blockHeight" DESC LIMIT 1`,
      [aggregateId, height]
    );
    if (rows.length > 0) return this._mapSnapshotRow(rows[0]);
    return null;
  }

  private _mapSnapshotRow(row: any): SnapshotDataModel {
    return {
      id: row.id,
      aggregateId: row.aggregateId ?? row.aggregateid,
      blockHeight: Number(row.blockHeight),
      version: Number(row.version),
      payload: row.payload,
      isCompressed: !!(row.isCompressed ?? row.iscompressed),
      createdAt: row.createdAt ? row.createdAt : new Date().toISOString(),
    };
  }

  /**
   * Batch-fetch and apply events to the model from current.sqlite3 only.
   *
   * - If blockHeight is provided → historical rehydration (events ≤ H, excluding NULL).
   * - If blockHeight is undefined → latest rehydration (no height cap; includes NULL heights).
   */
  public async applyEventsToAggregate({
    model,
    blockHeight,
    lastVersion = 0,
    batchSize = 5000,
  }: {
    model: T;
    blockHeight?: number;
    lastVersion?: number;
    batchSize?: number;
  }): Promise<void> {
    const table = model.aggregateId!;
    validateAggregateId(table);
    await this._applyEventsFromDataSource(this.dataSource, table, blockHeight, lastVersion, batchSize, model);
  }

  private async _applyEventsFromDataSource(
    ds: any,
    table: string,
    blockHeight: number | undefined,
    lastVersion: number,
    batchSize: number,
    model: T
  ): Promise<void> {
    let cursor = lastVersion;
    for (;;) {
      const params: any[] = [cursor];
      const heightSql = blockHeight == null ? '' : ` AND "blockHeight" IS NOT NULL AND "blockHeight" <= ?`;
      if (blockHeight != null) params.push(blockHeight);
      params.push(batchSize);

      const rows = (await ds.query(
        `SELECT "type","requestId","blockHeight","payload","isCompressed","version","timestamp"
         FROM "${table}"
         WHERE "version" > ?${heightSql}
         ORDER BY "version" ASC
         LIMIT ?`,
        params
      )) as Array<EventDataModel>;

      if (rows.length === 0) break;

      const batch: DomainEvent[] = [];
      for (const r of rows) {
        batch.push(
          await toDomainEvent(
            table,
            {
              type: r.type,
              requestId: r.requestId,
              blockHeight: r.blockHeight,
              payload: r.payload,
              isCompressed: !!r.isCompressed,
              version: r.version,
              timestamp: r.timestamp,
            },
            'sqlite'
          )
        );
      }
      model.loadFromHistory(batch);
      cursor = rows[rows.length - 1]!.version;
      if (rows.length < batchSize) break;
    }
  }

  public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) return;
    for (const id of aggregateIds) validateAggregateId(id);
    await this.writeLock.runExclusive(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE');
      try {
        for (const id of aggregateIds) {
          await qr.manager.query(`DELETE FROM "snapshots" WHERE "aggregateId" = ? AND "blockHeight" = ?`, [
            id,
            blockHeight,
          ]);
        }
        await qr.query('COMMIT');
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release();
      }
    });
  }

  public async pruneOldSnapshots(
    aggregateId: string,
    currentBlockHeight: number,
    opts: SnapshotOptions
  ): Promise<void> {
    validateAggregateId(aggregateId);
    const { minKeep, keepWindow } = opts;
    const protectFrom = keepWindow > 0 ? Math.max(0, currentBlockHeight - keepWindow) : 0;

    const rows = (await this.dataSource.query(
      `SELECT "id","blockHeight"
       FROM "snapshots"
       WHERE "aggregateId" = ?
       ORDER BY "blockHeight" DESC`,
      [aggregateId]
    )) as Array<{ id: number; blockHeight: number }>;

    if (rows.length <= minKeep) return;

    const toKeep = new Set<number>();
    for (let i = 0; i < Math.min(minKeep, rows.length); i++) {
      toKeep.add(rows[i]!.id);
    }
    for (const r of rows) {
      if (r.blockHeight >= protectFrom) toKeep.add(r.id);
    }

    const toDelete = rows.filter((r) => !toKeep.has(r.id)).map((r) => r.id);
    if (toDelete.length === 0) return;

    await this.writeLock.runExclusive(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE');
      try {
        const step = 10_000;
        for (let i = 0; i < toDelete.length; i += step) {
          const chunk = toDelete.slice(i, i + step);
          const placeholders = chunk.map(() => '?').join(',');
          await qr.manager.query(`DELETE FROM "snapshots" WHERE "id" IN (${placeholders})`, chunk);
        }
        await qr.query('COMMIT');
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release();
      }
    });
  }

  public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    validateAggregateId(aggregateId);
    await this.writeLock.runExclusive(async () => {
      await this.dataSource.query(
        `DELETE FROM "${aggregateId}" WHERE "blockHeight" IS NOT NULL AND "blockHeight" <= ?`,
        [pruneToBlockHeight]
      );
    });
  }

  public async restoreExactStateAtHeight(model: T, blockHeight: number): Promise<void> {
    validateAggregateId(model.aggregateId);
    const snap = await this.findLatestSnapshotBeforeHeight(model.aggregateId, blockHeight);

    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap, 'sqlite');
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, blockHeight, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model, blockHeight });
    }
  }

  public async restoreExactStateLatest(model: T): Promise<void> {
    validateAggregateId(model.aggregateId);
    // findLatestSnapshot only queries current file — the latest snapshot is always
    // copied there during rotation, so no archived file access is needed on the hot path.
    const snap = await this.findLatestSnapshot(model.aggregateId);
    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap, 'sqlite');
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model });
    }
  }

  // ─────────────────────────────── READ IMPLEMENTATION ───────────────────────────────

  public async fetchEventsForManyAggregatesRead(
    aggregateIds: string[],
    options: FindEventsOptions = {}
  ): Promise<EventReadRow[]> {
    for (const id of aggregateIds) validateAggregateId(id);
    return this._fetchEventsFromDataSource(this.dataSource, aggregateIds, options);
  }

  public async fetchEventsForOneAggregateRead(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): Promise<EventReadRow[]> {
    return this.fetchEventsForManyAggregatesRead([aggregateId], options);
  }

  /* eslint-disable require-yield */
  public async *streamEventsForOneAggregateRead(
    _aggregateId: string,
    _options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    throw new Error('Stream is not supported by this database driver (sqlite)');
  }

  public async *streamEventsForManyAggregatesRead(
    _aggregateIds: string[],
    _options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    throw new Error('Stream is not supported by this database driver (sqlite)');
  }
  /* eslint-enable require-yield */

  public async getOneModelByHeightRead(model: T, blockHeight: number): Promise<SnapshotReadRow | null> {
    const id = model.aggregateId;
    if (!id) return null;
    validateAggregateId(id);
    await this.restoreExactStateAtHeight(model, blockHeight);
    return toSnapshotReadRow(model);
  }

  public async getManyModelsByHeightRead(models: T[], blockHeight: number): Promise<SnapshotReadRow[]> {
    for (const model of models) validateAggregateId(model.aggregateId);
    if (models.length === 0) return [];
    const out: SnapshotReadRow[] = [];
    for (const m of models) {
      const row = await this.getOneModelByHeightRead(m, blockHeight);
      if (row) out.push(row);
    }
    return out;
  }

  // ─────────────────────────────── PRIVATE READ HELPERS ───────────────────────────────

  private async _fetchEventsFromDataSource(
    ds: any,
    aggregateIds: string[],
    options: FindEventsOptions
  ): Promise<EventReadRow[]> {
    const out: EventReadRow[] = [];
    const {
      versionGte,
      versionLte,
      heightGte,
      heightLte,
      limit,
      offset,
      orderBy = 'version',
      orderDir = 'asc',
    } = options;

    const orderCol = orderBy === 'createdAt' ? '"timestamp"' : '"version"';
    const orderDirSql = orderDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const effLimit = normalizeLimit(limit);
    const effOffset = normalizeOffset(offset);

    for (const id of aggregateIds) {
      const conds: string[] = [];
      const params: any[] = [];

      if (versionGte != null) {
        conds.push(`"version" >= ?`);
        params.push(versionGte);
      }
      if (versionLte != null) {
        conds.push(`"version" <= ?`);
        params.push(versionLte);
      }
      if (heightGte != null) {
        conds.push(`"blockHeight" IS NOT NULL AND "blockHeight" >= ?`);
        params.push(heightGte);
      }
      if (heightLte != null) {
        conds.push(`"blockHeight" IS NOT NULL AND "blockHeight" <= ?`);
        params.push(heightLte);
      }

      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const rows = await ds.query(
        `SELECT "type","payload","version","requestId","blockHeight","timestamp","isCompressed"
         FROM "${id}"
         ${whereSql}
         ORDER BY ${orderCol} ${orderDirSql}
         LIMIT ? OFFSET ?`,
        [...params, effLimit, effOffset]
      );

      for (const r of rows) {
        out.push(await toEventReadRow(id, r, 'sqlite'));
      }
    }
    return out;
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value == null) return 100;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100_000) {
    throw new Error(`Invalid limit "${value}"`);
  }
  return n;
}

function normalizeOffset(value: number | undefined): number {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid offset "${value}"`);
  }
  return n;
}
