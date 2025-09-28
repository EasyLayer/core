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
} from '../core';
import { BaseAdapter } from '../core';
import { toEventDataModel, toDomainEvent, toEventReadRow } from './event-data.serialize';
import { toWireEventRecord } from './outbox.deserialize';
import { toSnapshotDataModel, toSnapshotReadRow, toSnapshotParsedPayload } from './snapshot.serialize';

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

  /**
   * One-shot SQLite tuning for a single-process, write-heavy outbox.
   * Kept intentionally minimal and safe.
   *
   * - WAL + synchronous=NORMAL: fast and durable enough for single writer.
   * - locking_mode=EXCLUSIVE: only if this process is the sole writer (your case).
   * - cache_size: negative value → KiB. Here ~512 MiB to reduce I/O.
   * - temp_store=MEMORY: speed up temp structures (sorts, etc).
   * - wal_autocheckpoint: keeps WAL from growing indefinitely.
   * - mmap_size: faster reads if OS allows (not critical, but cheap).
   * - foreign_keys: OFF (no FK relations here; saves per-write overhead).
   */
  public async onModuleInit(): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`PRAGMA journal_mode = WAL`);
      await qr.query(`PRAGMA synchronous = NORMAL`);
      await qr.query(`PRAGMA busy_timeout = 5000`);

      await qr.query(`PRAGMA temp_store = MEMORY`);
      await qr.query(`PRAGMA cache_size = -524288`); // ~512 MiB

      await qr.query(`PRAGMA wal_autocheckpoint = 1000`); // ≈4 MiB with 4KiB page
      await qr.query(`PRAGMA mmap_size = 536870912`); // 512 MiB

      await qr.query(`PRAGMA locking_mode = EXCLUSIVE`);

      // FK checks are unnecessary for outbox/event tables; turn off for less overhead.
      await qr.query(`PRAGMA foreign_keys = OFF`);

      await qr.query(`PRAGMA optimize`);
    } finally {
      await qr.release();
    }
  }

  // ─────────────────────────────── WRITE PATH ───────────────────────────────

  /**
   * Persist unsaved events of each aggregate into:
   *   1) per-aggregate event table (BLOB payload)
   *   2) outbox (BLOB payload) — with client-generated monotonic id
   *
   * Returns the inserted outbox ids, and a raw (wire) array suitable for fast-path publish.
   * NOTE: firstTs/lastTs are returned for compatibility; adapter uses id-based checks internally.
   */
  public async persistAggregatesAndOutbox(aggregates: T[]): Promise<{
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
    avgUncompressedBytes?: number;
  }> {
    return this.writeLock.runExclusive(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE'); // short IMMEDIATE tx to avoid writer contention

      const outboxIds: string[] = [];
      const rawEvents: WireEventRecord[] = [];

      let firstIdBn: bigint | null = null;
      let lastIdBn: bigint | null = null;

      // We keep first/last timestamp just for compatibility with older service code.
      let firstTs = Number.MAX_SAFE_INTEGER;
      let lastTs = 0;

      try {
        for (const agg of aggregates) {
          const table = agg.aggregateId;
          if (!table) throw new Error('Aggregate has no aggregateId');

          const unsaved: DomainEvent[] = agg.getUnsavedEvents();
          if (unsaved.length === 0) continue;

          // First version for these unsaved events = agg.version - unsaved.length + 1
          const startVersion = agg.version - unsaved.length + 1;

          for (let i = 0; i < unsaved.length; i++) {
            const ev = unsaved[i] as DomainEvent;
            const version = startVersion + i;

            const row = await toEventDataModel(ev, version, 'sqlite');

            // Generate monotonic outbox id (uses event.timestamp in microseconds).
            const newId = this.idGen.next(ev.timestamp!);

            // (1) Insert into per-aggregate table (payload is BLOB).
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

            // (2) Insert into outbox with our monotonic id.
            await qr.manager.query(
              `INSERT OR IGNORE INTO "outbox"
                ("id","aggregateId","eventType","eventVersion","requestId","blockHeight","payload","isCompressed","timestamp","payload_uncompressed_bytes")
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
              [
                newId.toString(), // bind as string; SQLite will store as INTEGER
                table,
                row.type,
                row.version,
                row.requestId,
                row.blockHeight,
                row.payload,
                row.isCompressed ? 1 : 0,
                row.timestamp,
              ]
            );

            // Track id bounds (for compatibility return & diagnostics).
            if (firstIdBn === null || newId < firstIdBn) firstIdBn = newId;
            if (lastIdBn === null || newId > lastIdBn) lastIdBn = newId;

            // Track min/max timestamp only for compatibility (service no longer relies on it).
            if (ev.timestamp! < firstTs) firstTs = ev.timestamp!;
            if (ev.timestamp! > lastTs) lastTs = ev.timestamp!;

            // Build RAW wire record from the same BLOB via project deserializer.
            rawEvents.push(
              await toWireEventRecord({
                aggregateId: table,
                eventType: row.type,
                eventVersion: row.version,
                requestId: row.requestId,
                blockHeight: row.blockHeight,
                payload: row.payload,
                isCompressed: !!row.isCompressed, // for SQLite expected false
                timestamp: ev.timestamp!,
              })
            );

            outboxIds.push(newId.toString());
          }

          // Clear unsaved events after successful inserts for this aggregate.
          agg.markEventsAsSaved();
        }

        await qr.query('COMMIT');

        const firstId = firstIdBn ? String(firstIdBn) : '0';
        const lastId = lastIdBn ? String(lastIdBn) : '0';
        if (outboxIds.length === 0) {
          firstTs = 0;
          lastTs = 0;
        }

        return {
          insertedOutboxIds: outboxIds,
          firstTs,
          firstId,
          lastTs,
          lastId,
          rawEvents,
        };
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
    if (aggregateIds.length === 0) {
      return;
    }
    await this.writeLock.runExclusive(async () => {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN IMMEDIATE'); // SQLite write lock
      try {
        // 1) Per-aggregate event tables: delete above the rollback height
        for (const id of aggregateIds) {
          await qr.manager.query(`DELETE FROM "${id}" WHERE "blockHeight" > ?`, [blockHeight]);
        }

        // 2) Snapshots: delete snapshots after the rollback height for these aggregates
        const placeholders = aggregateIds.map(() => '?').join(',');
        await qr.manager.query(
          `DELETE FROM "snapshots" WHERE "blockHeight" > ? AND "aggregateId" IN (${placeholders})`,
          [blockHeight, ...aggregateIds]
        );

        // 3) Outbox: clear entirely to avoid publishing stale rows post-reorg
        await qr.manager.query(`DELETE FROM "outbox"`);

        await qr.query('COMMIT');
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release();
      }
    });

    // Reset streaming watermark (monotonic id)
    this.lastSeenId = 0n;
  }

  // ─────────────────────────────── BACKLOG TESTS ───────────────────────────────

  public async hasBacklogBefore(_ts: number, id: string): Promise<boolean> {
    const rows = await this.dataSource.query(`SELECT 1 FROM "outbox" WHERE id < CAST(? AS INTEGER) LIMIT 1`, [
      String(id),
    ]);
    return rows.length > 0;
  }

  public async hasAnyPendingAfterWatermark(): Promise<boolean> {
    const rows = await this.dataSource.query(`SELECT 1 FROM "outbox" WHERE id > CAST(? AS INTEGER) LIMIT 1`, [
      String(this.lastSeenId),
    ]);
    return rows.length > 0;
  }

  // ─────────────────────────────── DELIVER / ACK ───────────────────────────────

  /**
   * Delivery strategy (SQLite):
   * 1) Prefetch an ordered slice by id (LIMIT N), where
   *      N ≈ transportCapBytes / AVG_EVENT_BYTES_GUESS,
   *      clamped to [MIN_PREFETCH_ROWS .. MAX_PREFETCH_ROWS].
   * 2) In JS, greedily accumulate rows while
   *      (FIXED_OVERHEAD + payload_uncompressed_bytes) fits the budget.
   * 3) Deliver → ACK delete chosen ids.
   */
  public async fetchDeliverAckChunk(
    transportCapBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    return this.deliverLock.runExclusive(async () => {
      const wantRows = Math.max(1, Math.floor(transportCapBytes / SqliteAdapter.AVG_EVENT_BYTES_GUESS));
      const scanLimit = Math.max(SqliteAdapter.MIN_PREFETCH_ROWS, Math.min(SqliteAdapter.MAX_PREFETCH_ROWS, wantRows));

      const rows = (await this.dataSource.query(
        `SELECT CAST(id AS TEXT) AS id,
                "aggregateId" as aggregateId,
                "eventType"   as eventType,
                "eventVersion" as eventVersion,
                "requestId"   as requestId,
                "blockHeight" as blockHeight,
                "payload"     as payload,
                "isCompressed" as isCompressed,
                "timestamp"   as timestamp,
                "payload_uncompressed_bytes" as ulen
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

      // Pick first K rows that fit the transport budget (always at least one).
      const accepted: typeof rows = [];
      let running = 0;

      for (const r of rows) {
        const add = SqliteAdapter.FIXED_OVERHEAD + Number(r.ulen);
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
          payload: r.payload,
          isCompressed: !!r.isCompressed,
          timestamp: r.timestamp,
        });
      }

      const last = accepted[accepted.length - 1]!;
      const nextId = BigInt(last.id);

      await deliver(events);

      // ACK delete accepted ids.
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
        } catch (e) {
          await qr.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          await qr.release();
        }
      });

      this.lastSeenId = nextId;

      return events.length;
    });
  }

  // ─────────────────────────────── SNAPSHOTS / READ PATH ───────────────────────────────

  /** Persist the CURRENT aggregate state as a new snapshot. (kept from original) */
  public async createSnapshot(aggregate: T, opts: SnapshotOptions): Promise<void> {
    const row = await toSnapshotDataModel(aggregate, 'sqlite');
    await this.writeLock.runExclusive(async () => {
      await this.dataSource.query(
        `INSERT OR IGNORE INTO "snapshots" ("aggregateId","blockHeight","version","payload","isCompressed")
         VALUES (?,?,?,?,?)`,
        [row.aggregateId, row.blockHeight, row.version, row.payload, row.isCompressed ? 1 : 0]
      );
    });

    // Prune only if the aggregate explicitly allows pruning. (kept)
    const allow = aggregate.allowPruning === true;
    if (allow) {
      await this.pruneOldSnapshots(row.aggregateId, row.blockHeight, opts);
    }
  }

  /** Return latest snapshot (full DB row) for aggregateId. */
  public async findLatestSnapshot(aggregateId: string): Promise<SnapshotDataModel | null> {
    const rows = await this.dataSource.query(
      `SELECT "aggregateId","blockHeight","version","payload","isCompressed","createdAt"
       FROM "snapshots"
       WHERE "aggregateId" = ?
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [aggregateId]
    );
    if (rows.length === 0) return null;

    return {
      id: rows[0].id,
      aggregateId: rows[0].aggregateId ?? rows[0].aggregateid,
      blockHeight: Number(rows[0].blockHeight ?? rows[0].blockheight),
      version: Number(rows[0].version),
      payload: rows[0].payload,
      isCompressed: !!(rows[0].isCompressed ?? rows[0].iscompressed),
      createdAt: rows[0].createdAt ? rows[0].createdAt : new Date().toISOString(),
    };
  }

  /** Return latest snapshot (full DB row) ≤ given height. */
  public async findLatestSnapshotBeforeHeight(aggregateId: string, height: number): Promise<SnapshotDataModel | null> {
    const rows = await this.dataSource.query(
      `SELECT "aggregateId","blockHeight","version","payload","isCompressed","createdAt"
       FROM "snapshots"
       WHERE "aggregateId" = ? AND "blockHeight" <= ?
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [aggregateId, height]
    );
    if (rows.length === 0) return null;

    return {
      id: rows[0].id,
      aggregateId: rows[0].aggregateId ?? rows[0].aggregateid,
      blockHeight: Number(rows[0].blockHeight ?? rows[0].blockheight),
      version: Number(rows[0].version),
      payload: rows[0].payload,
      isCompressed: !!(rows[0].isCompressed ?? rows[0].iscompressed),
      createdAt: rows[0].createdAt ? rows[0].createdAt : new Date().toISOString(),
    };
  }

  /**
   * Batch-fetch and apply events to the model.
   * - If `blockHeight` is provided → historical rehydration (events with blockHeight ≤ H, excluding NULL).
   * - If `blockHeight` is undefined → latest rehydration (no height cap; includes NULL heights).
   * - Fetch strictly ordered by version ASC; loop in batches to avoid large memory spikes.
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
    let cursor = lastVersion;

    for (;;) {
      const params: any[] = [cursor];
      const heightSql = blockHeight == null ? '' : ` AND "blockHeight" IS NOT NULL AND "blockHeight" <= ?`;
      if (blockHeight != null) params.push(blockHeight);
      params.push(batchSize);

      const rows = (await this.dataSource.query(
        `SELECT "type","requestId","blockHeight","payload","isCompressed","version","timestamp"
         FROM "${table}"
         WHERE "version" > ?${heightSql}
         ORDER BY "version" ASC
         LIMIT ?`,
        params
      )) as Array<EventDataModel>;

      if (rows.length === 0) break;

      // Convert to DomainEvent via project deserializer (does decompress+parse)
      const batch: DomainEvent[] = [];
      for (const r of rows) {
        const ev = await toDomainEvent(
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
        );
        batch.push(ev);
      }

      // Apply to aggregate
      model.loadFromHistory(batch);

      // Advance
      cursor = rows[rows.length - 1]!.version;
      if (rows.length < batchSize) break;
    }
  }

  public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) return;
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
    await this.writeLock.runExclusive(async () => {
      await this.dataSource.query(
        `DELETE FROM "${aggregateId}" WHERE "blockHeight" IS NOT NULL AND "blockHeight" <= ?`,
        [pruneToBlockHeight]
      );
    });
  }

  public async restoreExactStateAtHeight(model: T, blockHeight: number): Promise<void> {
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
    const snap = await this.findLatestSnapshot(model.aggregateId);
    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap, 'sqlite');
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ───────────── READ IMPLEMENTATION (payload → string, no JSON.parse) ─
  // ───────────────────────────────────────────────────────────────────────────

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

    const orderCol = orderBy === 'createdAt' ? '"timestamp"' : '"version"';
    const orderDirSql = orderDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const effLimit = limit == null ? 100 : Number(limit);
    const effOffset = offset == null ? 0 : Number(offset);

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

      const rows = await this.dataSource.query(
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

  public async fetchEventsForOneAggregateRead(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): Promise<EventReadRow[]> {
    return this.fetchEventsForManyAggregatesRead([aggregateId], options);
  }

  /* eslint-disable require-yield */
  /** Stream is not supported by this database driver (sqlite). */
  public async *streamEventsForOneAggregateRead(
    _aggregateId: string,
    _options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    throw new Error('Stream is not supported by this database driver (sqlite)');
  }
  /* eslint-enable require-yield */

  /* eslint-disable require-yield */
  /** Stream is not supported by this database driver (sqlite). */
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
