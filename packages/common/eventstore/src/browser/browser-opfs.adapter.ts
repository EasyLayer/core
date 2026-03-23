import { Mutex } from 'async-mutex';
import { Buffer } from 'buffer';
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
} from '../core';
import { BaseAdapter } from '../core';
import { toEventDataModel, toDomainEvent, toEventReadRow } from './event-data.serialize';
import { toWireEventRecord } from './outbox.deserialize';
import { toSnapshotDataModel, toSnapshotReadRow, toSnapshotParsedPayload } from './snapshot.serialize';

function toBuffer(x: any): Buffer {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  return Buffer.from(String(x));
}

type Sqlite3Db = any;

// ── DDL ──────────────────────────────────────────────────────────────────────

const DDL_OUTBOX = `
CREATE TABLE IF NOT EXISTS "outbox" (
  id                TEXT    NOT NULL,
  aggregateId       TEXT    NOT NULL,
  eventType         TEXT    NOT NULL,
  eventVersion      INTEGER NOT NULL,
  requestId         TEXT    NOT NULL,
  blockHeight       INTEGER,
  payload           BLOB    NOT NULL,
  timestamp         INTEGER NOT NULL,
  isCompressed      INTEGER NOT NULL DEFAULT 0,
  uncompressedBytes INTEGER,
  PRIMARY KEY (id),
  UNIQUE (aggregateId, eventVersion)
);
CREATE INDEX IF NOT EXISTS IDX_outbox_id ON "outbox"(CAST(id AS INTEGER));
`;

const DDL_SNAPSHOTS = `
CREATE TABLE IF NOT EXISTS "snapshots" (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregateId   TEXT    NOT NULL,
  blockHeight   INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 0,
  payload       BLOB    NOT NULL,
  isCompressed  INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (aggregateId, blockHeight)
);
CREATE INDEX IF NOT EXISTS IDX_snap_agg_bh ON "snapshots"(aggregateId, blockHeight);
CREATE INDEX IF NOT EXISTS IDX_snap_bh     ON "snapshots"(blockHeight);
`;

function ddlAggregateTable(aggregateId: string): string {
  return `
CREATE TABLE IF NOT EXISTS "${aggregateId}" (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       INTEGER NOT NULL DEFAULT 0,
  requestId     TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  payload       BLOB    NOT NULL,
  blockHeight   INTEGER,
  isCompressed  INTEGER NOT NULL DEFAULT 0,
  timestamp     INTEGER NOT NULL,
  UNIQUE (version, requestId)
);
CREATE INDEX IF NOT EXISTS "IDX_${aggregateId.replace(/[^a-zA-Z0-9]/g, '_')}_bh"
  ON "${aggregateId}"(blockHeight);
`;
}

/**
 * Browser OPFS adapter.
 *
 * Replaces BrowserSqljsAdapter (TypeORM + sql.js + localforage).
 * Uses @sqlite.org/sqlite-wasm with the OPFS SAH Pool VFS.
 * Data is persisted directly to the Origin Private File System.
 *
 * Requires SharedWorker + COOP/COEP headers.
 */
export class BrowserOpfsAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  private db!: Sqlite3Db;
  private writeLock = new Mutex();
  private deliverLock = new Mutex();
  private lastSeenId = 0n;

  private static readonly FIXED_OVERHEAD = 256;
  private static readonly AVG_EVENT_BYTES_GUESS = 8 * 1024;
  private static readonly MIN_PREFETCH_ROWS = 256;
  private static readonly MAX_PREFETCH_ROWS = 8192;
  private static readonly DELETE_ID_CHUNK = 10_000;

  constructor() {
    super(null);
  }

  async init(db: Sqlite3Db, aggregateIds: string[] = []): Promise<void> {
    this.db = db;
    db.exec(DDL_OUTBOX);
    db.exec(DDL_SNAPSHOTS);
    for (const id of aggregateIds) {
      db.exec(ddlAggregateTable(id));
    }
  }

  private ensureAggTable(aggregateId: string): void {
    this.db.exec(ddlAggregateTable(aggregateId));
  }

  private query<R = Record<string, any>>(sql: string, bind: any[] = []): R[] {
    try {
      return this.db.exec({ sql, bind, returnValue: 'resultRows', rowMode: 'object' }) as R[];
    } catch (e: any) {
      throw e;
    }
  }

  private run(sql: string, bind: any[] = []): void {
    this.db.exec({ sql, bind });
  }

  // ── WRITE PATH ─────────────────────────────────────────────────────────────

  public async persistAggregatesAndOutbox(aggregates: T[]): Promise<{
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }> {
    return this.writeLock.runExclusive(async () => {
      const outboxIds: string[] = [];
      const rawEvents: WireEventRecord[] = [];
      let firstIdBn: bigint | null = null;
      let lastIdBn: bigint | null = null;
      let firstTs = Number.MAX_SAFE_INTEGER;
      let lastTs = 0;

      this.run('BEGIN');
      try {
        for (const agg of aggregates) {
          const table = agg.aggregateId;
          if (!table) throw new Error('Aggregate has no aggregateId');
          const unsaved = agg.getUnsavedEvents();
          if (unsaved.length === 0) continue;

          this.ensureAggTable(table);
          const startVersion = agg.version - unsaved.length + 1;

          for (let i = 0; i < unsaved.length; i++) {
            const ev = unsaved[i] as DomainEvent;
            const version = startVersion + i;
            const row = await toEventDataModel(ev, version);
            const newId = this.idGen.next(ev.timestamp!);

            this.run(
              `INSERT OR IGNORE INTO "${table}"
                 (version, requestId, type, payload, blockHeight, isCompressed, timestamp)
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

            this.run(
              `INSERT OR IGNORE INTO "outbox"
                 (id, aggregateId, eventType, eventVersion, requestId, blockHeight,
                  payload, isCompressed, timestamp, uncompressedBytes)
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

            outboxIds.push(newId.toString());
          }
        }

        this.run('COMMIT');
        for (const agg of aggregates) agg.markEventsAsSaved();

        const firstId = firstIdBn ? String(firstIdBn) : '0';
        const lastId = lastIdBn ? String(lastIdBn) : '0';
        if (outboxIds.length === 0) {
          firstTs = 0;
          lastTs = 0;
        }

        return { insertedOutboxIds: outboxIds, firstTs, firstId, lastTs, lastId, rawEvents };
      } catch (e) {
        this.run('ROLLBACK');
        throw e;
      }
    });
  }

  public async deleteOutboxByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.writeLock.runExclusive(async () => {
      this.run('BEGIN');
      try {
        const step = BrowserOpfsAdapter.DELETE_ID_CHUNK;
        for (let i = 0; i < ids.length; i += step) {
          const chunk = ids.slice(i, i + step);
          const ph = chunk.map(() => '?').join(',');
          this.run(`DELETE FROM "outbox" WHERE id IN (${ph})`, chunk);
        }
        this.run('COMMIT');
      } catch (e) {
        this.run('ROLLBACK');
        throw e;
      }
    });
  }

  public async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) return;
    return this.writeLock.runExclusive(async () => {
      this.run('BEGIN');
      try {
        for (const id of aggregateIds) {
          this.run(`DELETE FROM "${id}" WHERE blockHeight > ?`, [blockHeight]);
        }
        const ph = aggregateIds.map(() => '?').join(',');
        this.run(`DELETE FROM "snapshots" WHERE blockHeight > ? AND aggregateId IN (${ph})`, [
          blockHeight,
          ...aggregateIds,
        ]);
        this.run(`DELETE FROM "outbox"`);
        this.run('COMMIT');
      } catch (e) {
        this.run('ROLLBACK');
        throw e;
      }
      this.lastSeenId = 0n;
    });
  }

  // ── BACKLOG ────────────────────────────────────────────────────────────────

  public async hasBacklogBefore(_ts: number, id: string): Promise<boolean> {
    const rows = this.query<{ x: number }>(
      `SELECT 1 AS x FROM "outbox" WHERE CAST(id AS INTEGER) < CAST(? AS INTEGER) LIMIT 1`,
      [String(id)]
    );
    return rows.length > 0;
  }

  public async hasAnyPendingAfterWatermark(): Promise<boolean> {
    const rows = this.query<{ x: number }>(
      `SELECT 1 AS x FROM "outbox" WHERE CAST(id AS INTEGER) > CAST(? AS INTEGER) LIMIT 1`,
      [String(this.lastSeenId)]
    );
    return rows.length > 0;
  }

  // ── DRAIN ─────────────────────────────────────────────────────────────────

  public async fetchDeliverAckChunk(
    transportCapBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    return this.deliverLock.runExclusive(async () => {
      const want = Math.max(1, Math.floor(transportCapBytes / BrowserOpfsAdapter.AVG_EVENT_BYTES_GUESS));
      const limit = Math.max(
        BrowserOpfsAdapter.MIN_PREFETCH_ROWS,
        Math.min(BrowserOpfsAdapter.MAX_PREFETCH_ROWS, want)
      );

      type OutboxRow = {
        id: string;
        aggregateId: string;
        eventType: string;
        eventVersion: number;
        requestId: string;
        blockHeight: number | null;
        payload: any;
        isCompressed: number;
        timestamp: number;
        ulen: number;
      };

      const rows = this.query<OutboxRow>(
        `SELECT CAST(id AS TEXT) AS id,
                aggregateId, eventType, eventVersion, requestId, blockHeight,
                payload, isCompressed, timestamp, uncompressedBytes AS ulen
           FROM "outbox"
          WHERE CAST(id AS INTEGER) > CAST(? AS INTEGER)
          ORDER BY CAST(id AS INTEGER) ASC
          LIMIT ${limit}`,
        [String(this.lastSeenId)]
      );

      if (rows.length === 0) return 0;

      const accepted: OutboxRow[] = [];
      let running = 0;
      for (const r of rows) {
        const add = BrowserOpfsAdapter.FIXED_OVERHEAD + Number(r.ulen ?? 0);
        if (accepted.length === 0) {
          accepted.push(r);
          running += add;
          continue;
        }
        if (running + add > transportCapBytes) break;
        accepted.push(r);
        running += add;
      }

      const events: WireEventRecord[] = new Array(accepted.length);
      for (let i = 0; i < accepted.length; i++) {
        const r = accepted[i]!;
        events[i] = await toWireEventRecord({
          aggregateId: r.aggregateId,
          eventType: r.eventType,
          eventVersion: r.eventVersion,
          requestId: r.requestId,
          blockHeight: r.blockHeight!,
          payload: toBuffer(r.payload),
          isCompressed: !!r.isCompressed,
          timestamp: r.timestamp,
        });
      }

      const nextId = BigInt(accepted[accepted.length - 1]!.id);
      await deliver(events);

      await this.writeLock.runExclusive(async () => {
        const ids = accepted.map((r) => r.id);
        this.run('BEGIN');
        try {
          const step = BrowserOpfsAdapter.DELETE_ID_CHUNK;
          for (let i = 0; i < ids.length; i += step) {
            const chunk = ids.slice(i, i + step);
            const ph = chunk.map(() => '?').join(',');
            this.run(`DELETE FROM "outbox" WHERE id IN (${ph})`, chunk);
          }
          this.run('COMMIT');
        } catch (e) {
          this.run('ROLLBACK');
          throw e;
        }
      });

      this.lastSeenId = nextId;
      return events.length;
    });
  }

  public advanceWatermark(lastId: string): void {
    const id = BigInt(lastId);
    if (id > this.lastSeenId) this.lastSeenId = id;
  }

  // ── SNAPSHOTS ──────────────────────────────────────────────────────────────

  public async createSnapshot(aggregate: T, opts: SnapshotOptions): Promise<void> {
    return this.writeLock.runExclusive(async () => {
      const row = await toSnapshotDataModel(aggregate);
      this.run(
        `INSERT OR IGNORE INTO "snapshots" (aggregateId, blockHeight, version, payload, isCompressed)
         VALUES (?,?,?,?,?)`,
        [row.aggregateId, row.blockHeight, row.version, row.payload, row.isCompressed ? 1 : 0]
      );
      if ((aggregate as any).allowPruning === true) {
        await this.pruneOldSnapshots(row.aggregateId, row.blockHeight, opts);
      }
    });
  }

  public async findLatestSnapshot(aggregateId: string): Promise<SnapshotDataModel | null> {
    const rows = this.query<any>(
      `SELECT id, aggregateId, blockHeight, version, payload, isCompressed, createdAt
         FROM "snapshots" WHERE aggregateId = ? ORDER BY blockHeight DESC LIMIT 1`,
      [aggregateId]
    );
    return rows.length === 0 ? null : this.mapSnapshot(rows[0]);
  }

  public async findLatestSnapshotBeforeHeight(aggregateId: string, height: number): Promise<SnapshotDataModel | null> {
    const rows = this.query<any>(
      `SELECT id, aggregateId, blockHeight, version, payload, isCompressed, createdAt
         FROM "snapshots" WHERE aggregateId = ? AND blockHeight <= ? ORDER BY blockHeight DESC LIMIT 1`,
      [aggregateId, height]
    );
    return rows.length === 0 ? null : this.mapSnapshot(rows[0]);
  }

  private mapSnapshot(r: any): SnapshotDataModel {
    return {
      id: String(r.id ?? '0'),
      aggregateId: r.aggregateId,
      blockHeight: Number(r.blockHeight),
      version: Number(r.version),
      payload: toBuffer(r.payload),
      isCompressed: !!r.isCompressed,
      createdAt: r.createdAt ?? new Date().toISOString(),
    };
  }

  // ── REHYDRATION ────────────────────────────────────────────────────────────

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
    let cursor = lastVersion;

    for (;;) {
      const params: any[] = [cursor];
      const heightSql = blockHeight == null ? '' : ` AND blockHeight IS NOT NULL AND blockHeight <= ?`;
      if (blockHeight != null) params.push(blockHeight);
      params.push(batchSize);

      const rows = this.query<EventDataModel>(
        `SELECT type, requestId, blockHeight, payload, isCompressed, version, timestamp
           FROM "${table}" WHERE version > ?${heightSql} ORDER BY version ASC LIMIT ?`,
        params
      );
      if (rows.length === 0) break;

      const batch: DomainEvent[] = [];
      for (const r of rows) {
        batch.push(
          await toDomainEvent(table, {
            type: r.type,
            requestId: r.requestId,
            blockHeight: r.blockHeight,
            payload: toBuffer(r.payload),
            isCompressed: !!r.isCompressed,
            version: r.version,
            timestamp: r.timestamp,
          })
        );
      }
      model.loadFromHistory(batch);

      cursor = rows[rows.length - 1]!.version;
      if (rows.length < batchSize) break;
    }
  }

  public async restoreExactStateAtHeight(model: T, blockHeight: number): Promise<void> {
    const snap = await this.findLatestSnapshotBeforeHeight(model.aggregateId, blockHeight);
    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap);
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, blockHeight, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model, blockHeight });
    }
  }

  public async restoreExactStateLatest(model: T): Promise<void> {
    const snap = await this.findLatestSnapshot(model.aggregateId);
    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap);
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model });
    }
  }

  public async pruneOldSnapshots(
    aggregateId: string,
    currentBlockHeight: number,
    opts: SnapshotOptions
  ): Promise<void> {
    const { minKeep, keepWindow } = opts;
    const protectFrom = keepWindow > 0 ? Math.max(0, currentBlockHeight - keepWindow) : 0;

    const rows = this.query<{ id: number; blockHeight: number }>(
      `SELECT id, blockHeight FROM "snapshots" WHERE aggregateId = ? ORDER BY blockHeight DESC`,
      [aggregateId]
    );
    if (rows.length <= minKeep) return;

    const toKeep = new Set<number>();
    for (let i = 0; i < Math.min(minKeep, rows.length); i++) toKeep.add(rows[i]!.id);
    for (const r of rows) {
      if (r.blockHeight >= protectFrom) toKeep.add(r.id);
    }

    const toDelete = rows.filter((r) => !toKeep.has(r.id)).map((r) => r.id);
    if (toDelete.length === 0) return;

    return this.writeLock.runExclusive(async () => {
      this.run('BEGIN');
      try {
        const step = BrowserOpfsAdapter.DELETE_ID_CHUNK;
        for (let i = 0; i < toDelete.length; i += step) {
          const chunk = toDelete.slice(i, i + step);
          const ph = chunk.map(() => '?').join(',');
          this.run(`DELETE FROM "snapshots" WHERE id IN (${ph})`, chunk);
        }
        this.run('COMMIT');
      } catch (e) {
        this.run('ROLLBACK');
        throw e;
      }
    });
  }

  public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    return this.writeLock.runExclusive(async () => {
      this.run(`DELETE FROM "${aggregateId}" WHERE blockHeight IS NOT NULL AND blockHeight <= ?`, [pruneToBlockHeight]);
    });
  }

  // ── READ API ───────────────────────────────────────────────────────────────

  public async fetchEventsForManyAggregatesRead(
    aggregateIds: string[],
    options: FindEventsOptions = {}
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
    const orderCol = orderBy === 'createdAt' ? 'timestamp' : 'version';
    const orderDirSql = orderDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const effLimit = limit == null ? 100 : Number(limit);
    const effOffset = offset == null ? 0 : Number(offset);

    for (const id of aggregateIds) {
      const conds: string[] = [];
      const params: any[] = [];
      if (versionGte != null) {
        conds.push(`version >= ?`);
        params.push(versionGte);
      }
      if (versionLte != null) {
        conds.push(`version <= ?`);
        params.push(versionLte);
      }
      if (heightGte != null) {
        conds.push(`blockHeight IS NOT NULL AND blockHeight >= ?`);
        params.push(heightGte);
      }
      if (heightLte != null) {
        conds.push(`blockHeight IS NOT NULL AND blockHeight <= ?`);
        params.push(heightLte);
      }

      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = this.query<EventDataModel>(
        `SELECT type, payload, version, requestId, blockHeight, timestamp, isCompressed
           FROM "${id}" ${whereSql} ORDER BY ${orderCol} ${orderDirSql} LIMIT ? OFFSET ?`,
        [...params, effLimit, effOffset]
      );
      for (const r of rows) {
        out.push(await toEventReadRow(id, { ...r, payload: toBuffer(r.payload) }, 'sqlite'));
      }
    }
    return out;
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
    throw new Error('Stream is not supported by this database driver (opfs-sqlite)');
  }
  public async *streamEventsForManyAggregatesRead(
    _aggregateIds: string[],
    _options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    throw new Error('Stream is not supported by this database driver (opfs-sqlite)');
  }
  /* eslint-enable require-yield */

  public async getOneModelByHeightRead(model: T, blockHeight: number): Promise<SnapshotReadRow | null> {
    if (!model.aggregateId) return null;
    await this.restoreExactStateAtHeight(model, blockHeight);
    return toSnapshotReadRow(model);
  }

  public async getManyModelsByHeightRead(models: T[], blockHeight: number): Promise<SnapshotReadRow[]> {
    if (models.length === 0) return [];
    const out: SnapshotReadRow[] = [];
    for (const m of models) {
      const row = await this.getOneModelByHeightRead(m, blockHeight);
      if (row) out.push(row);
    }
    return out;
  }
}
