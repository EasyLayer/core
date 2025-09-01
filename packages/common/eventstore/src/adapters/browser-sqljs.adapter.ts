import type { AggregateRoot, DomainEvent } from '@easylayer/common/cqrs';
import type { WireEventRecord } from '@easylayer/common/cqrs-transport';
import type { SnapshotOptions } from './base-adapter';
import { BaseAdapter } from './base-adapter';
import { serializeEventRow, deserializeToDomainEvent } from '../event-data.model';
import { deserializeToOutboxRaw } from '../outbox.model';
import { serializeSnapshot, deserializeSnapshot } from '../snapshots.model';

function toBuffer(x: any): Buffer {
  return Buffer.isBuffer(x) ? x : Buffer.from(x);
}

/**
 * Browser (sql.js / IndexedDB) adapter.
 *
 * Key points kept from your last version:
 * - Driver tag for serializers is 'sqljs'.
 * - BEGIN/COMMIT without SQLite lock qualifiers.
 * - Payloads are stored as BLOB (byte arrays in sql.js).
 * - Prefetch + JS greedy accumulate against transport budget (unchanged).
 * - Manual flush to IndexedDB right after COMMIT.
 * - Client-generated monotonic BIGINT "id" for outbox (no RETURNING/select).
 * - Watermark uses only that id (id > lastSeenId).
 * - No ad-hoc JSON ops; only project (de)serializers.
 * - Never calls aggregate.apply(); only loadFromHistory().
 */
export class BrowserSqljsAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  /** Outbox streaming watermark (strictly increasing BIGINT id). */
  private lastSeenId = 0n;

  // Wire/scan tuning — kept same as in your previous sqljs version.
  private static readonly FIXED_OVERHEAD = 256; // per-event wire envelope approximation (bytes)
  private static readonly AVG_EVENT_BYTES_GUESS = 8 * 1024; // coarse average of uncompressed JSON
  private static readonly MIN_PREFETCH_ROWS = 256; // same as (earlier) SQLite settings you used for sqljs
  private static readonly MAX_PREFETCH_ROWS = 8192;
  private static readonly DELETE_ID_CHUNK = 10000; // IN() fanout cap for deletes

  /**
   * sql.js runs entirely in memory; WAL/locking do not apply.
   * We keep journaling in memory and disable sync to avoid extra work.
   * Also keep a modest cache and temp data in memory.
   *
   * IMPORTANT: For durability you already call persistToDiskIfSupported()
   * after each COMMIT — that is what flushes to IndexedDB.
   */
  public async onModuleInit(): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`PRAGMA journal_mode = MEMORY`);
      await qr.query(`PRAGMA synchronous = OFF`);

      await qr.query(`PRAGMA temp_store = MEMORY`);
      await qr.query(`PRAGMA cache_size = -131072`); // ~128 MiB (browser RAM is precious)

      // No FK relations in outbox/event tables; save a few cycles per write.
      await qr.query(`PRAGMA foreign_keys = OFF`);

      await qr.query(`PRAGMA optimize`);
    } finally {
      await qr.release();
    }
  }

  // ─────────────────────────── WRITE PATH ───────────────────────────

  /**
   * Persist unsaved events:
   *  1) per-aggregate event table (BLOB payload)
   *  2) outbox with client-generated monotonic BIGINT id
   *
   * Returns inserted ids (numeric view), first/last id+ts (for compatibility),
   * and RAW wire events for fast-path publish.
   */
  public async persistAggregatesAndOutbox(aggregates: T[]): Promise<{
    insertedOutboxIds: string[];
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
  }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');

    const outboxIds: string[] = [];
    const rawEvents: WireEventRecord[] = [];

    let firstIdBn: bigint | null = null;
    let lastIdBn: bigint | null = null;
    let firstTs = Number.MAX_SAFE_INTEGER;
    let lastTs = 0;

    try {
      for (const agg of aggregates) {
        const table = agg.aggregateId;
        if (!table) {
          throw new Error('Aggregate has no aggregateId');
        }

        const unsaved = agg.getUnsavedEvents();
        if (unsaved.length === 0) {
          continue;
        }

        const startVersion = agg.version - unsaved.length + 1;

        for (let i = 0; i < unsaved.length; i++) {
          const ev = unsaved[i] as DomainEvent;
          const version = startVersion + i;

          // Single-pass serialization; driver tag is 'sqljs'.
          const row = await serializeEventRow(ev, version, 'sqljs');

          // Monotonic id from event.timestamp (µs).
          const newId = this.idGen.next(ev.timestamp!);

          // (1) Aggregate table insert (BLOB).
          await qr.manager.query(
            `INSERT OR IGNORE INTO "${table}"
               ("version","requestId","type","payload","blockHeight","isCompressed","timestamp")
             VALUES (?,?,?,?,?,?,?)`,
            [
              row.version,
              row.requestId,
              row.type,
              row.payload, // BLOB
              row.blockHeight,
              row.isCompressed ? 1 : 0, // sql.js boolean storage
              row.timestamp,
            ]
          );

          // (2) Outbox insert using our precomputed id.
          await qr.manager.query(
            `INSERT OR IGNORE INTO "outbox"
               ("id","aggregateId","eventType","eventVersion","requestId","blockHeight","payload","isCompressed","timestamp","payload_uncompressed_bytes")
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [
              newId.toString(), // BIGINT as string literal
              table,
              row.type,
              row.version,
              row.requestId,
              row.blockHeight,
              row.payload, // same BLOB
              row.isCompressed ? 1 : 0,
              row.timestamp,
              row.payloadUncompressedBytes,
            ]
          );

          // Track id/ts bounds (compatibility with previous return contract).
          if (firstIdBn === null || newId < firstIdBn) firstIdBn = newId;
          if (lastIdBn === null || newId > lastIdBn) lastIdBn = newId;
          if (ev.timestamp! < firstTs) firstTs = ev.timestamp!;
          if (ev.timestamp! > lastTs) lastTs = ev.timestamp!;

          // Build RAW wire record (payload as JSON string, via deserializer).
          rawEvents.push(
            await deserializeToOutboxRaw({
              aggregateId: table,
              eventType: row.type,
              eventVersion: row.version,
              requestId: row.requestId,
              blockHeight: row.blockHeight,
              payload: row.payload,
              isCompressed: !!row.isCompressed, // for sqljs this is typically false
              timestamp: ev.timestamp!,
            })
          );

          outboxIds.push(newId.toString());
        }

        // Mark as saved after successful flush for this aggregate.
        agg.markEventsAsSaved();
      }

      await qr.query('COMMIT');

      // Manual flush to persistent storage (IndexedDB) after COMMIT.
      await this.persistToDiskIfSupported();

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
  }

  public async deleteOutboxByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      const step = BrowserSqljsAdapter.DELETE_ID_CHUNK;
      for (let i = 0; i < ids.length; i += step) {
        const chunk = ids.slice(i, i + step);
        const placeholders = chunk.map(() => '?').join(',');
        await qr.manager.query(`DELETE FROM "outbox" WHERE "id" IN (${placeholders})`, chunk);
      }
      await qr.query('COMMIT');
      await this.persistToDiskIfSupported();
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ─────────────────────────── BACKLOG TESTS ───────────────────────────

  /** API compatibility; we ignore ts and use monotonic id. */
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

  // ─────────────────────────── DRAIN (prefetch + greedy accumulate) ───────────────────────────

  /**
   * Prefetch by id and greedily accumulate rows until the transport budget is reached:
   *  1) LIMIT ~ cap / AVG_EVENT_BYTES_GUESS, clamped to [MIN..MAX]
   *  2) Sum FIXED_OVERHEAD + payload_uncompressed_bytes
   *  3) Deliver → ACK delete → advance watermark
   */
  public async fetchDeliverAckChunk(
    transportCapBytes: number,
    deliver: (events: WireEventRecord[]) => Promise<void>
  ): Promise<number> {
    const want = Math.max(1, Math.floor(transportCapBytes / BrowserSqljsAdapter.AVG_EVENT_BYTES_GUESS));
    const limit = Math.max(
      BrowserSqljsAdapter.MIN_PREFETCH_ROWS,
      Math.min(BrowserSqljsAdapter.MAX_PREFETCH_ROWS, want)
    );

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
      LIMIT ${limit}`,
      [String(this.lastSeenId)]
    )) as Array<{
      id: string; // stored as BIGINT string literal
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

    if (rows.length === 0) {
      return 0;
    }

    // Greedy accept — always take at least one row.
    const accepted: typeof rows = [];
    let running = 0;

    for (const r of rows) {
      const add = BrowserSqljsAdapter.FIXED_OVERHEAD + Number(r.ulen);
      if (accepted.length === 0) {
        accepted.push(r);
        running += add;
        continue;
      }
      if (running + add > transportCapBytes) {
        break;
      }
      accepted.push(r);
      running += add;
    }

    const events: WireEventRecord[] = new Array(accepted.length);
    for (let i = 0; i < accepted.length; i++) {
      const r = accepted[i]!;
      events[i] = await deserializeToOutboxRaw({
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

    const last = accepted[accepted.length - 1]!;
    const nextId = BigInt(last.id);

    await deliver(events);

    // ACK delete
    const ids = accepted.map((r) => r.id);
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN IMMEDIATE');
    try {
      const step = BrowserSqljsAdapter.DELETE_ID_CHUNK;
      for (let i = 0; i < ids.length; i += step) {
        const chunk = ids.slice(i, i + step).map((x) => String(x).trim());
        const placeholders = chunk.map(() => 'CAST(? AS INTEGER)').join(',');
        await qr.manager.query(`DELETE FROM "outbox" WHERE id IN (${placeholders})`, chunk);
      }
      await qr.query('COMMIT');
      await this.persistToDiskIfSupported();
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      await qr.release().catch(() => undefined);
      throw e;
    }
    await qr.release();

    this.lastSeenId = nextId;

    return events.length;
  }

  // ─────────────────────────── SNAPSHOTS / READ PATH ───────────────────────────

  public async createSnapshot(aggregate: T, opts: SnapshotOptions): Promise<void> {
    const row = await serializeSnapshot(aggregate, 'sqljs');
    await this.dataSource.query(
      `INSERT OR IGNORE INTO "snapshots" ("aggregateId","blockHeight","version","payload","isCompressed")
       VALUES (?,?,?,?,?)`,
      [row.aggregateId, row.blockHeight, row.version, row.payload, row.isCompressed ? 1 : 0]
    );

    // Prune only if the aggregate explicitly allows pruning.
    const allow = (aggregate as any).allowPruning === true;
    if (allow) {
      await this.pruneOldSnapshots(row.aggregateId, row.blockHeight, opts);
    }

    await this.persistToDiskIfSupported();
  }

  public async findLatestSnapshot(aggregateId: string): Promise<{ blockHeight: number } | null> {
    const rows = await this.dataSource.query(
      `SELECT "blockHeight"
       FROM "snapshots"
       WHERE "aggregateId" = ?
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [aggregateId]
    );
    if (rows.length === 0) {
      return null;
    }
    return { blockHeight: Number(rows[0].blockHeight ?? rows[0].blockheight) };
  }

  public async createSnapshotAtHeight<K extends T>(
    model: K,
    height: number
  ): Promise<{ aggregateId: string; version: number; blockHeight: number; payload: any }> {
    const rows = await this.dataSource.query(
      `SELECT "aggregateId","blockHeight","version","payload","isCompressed"
       FROM "snapshots"
       WHERE "aggregateId" = ? AND "blockHeight" <= ?
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [model.aggregateId, height]
    );

    if (rows.length === 0) {
      return { aggregateId: model.aggregateId!, version: 0, blockHeight: 0, payload: {} };
    }

    const snap = await deserializeSnapshot(
      {
        id: '0',
        aggregateId: rows[0].aggregateId ?? rows[0].aggregateid,
        blockHeight: Number(rows[0].blockHeight ?? rows[0].blockheight),
        version: Number(rows[0].version),
        payload: toBuffer(rows[0].payload),
        isCompressed: !!(rows[0].isCompressed ?? rows[0].iscompressed),
        createdAt: new Date(),
      },
      'sqljs'
    );

    return {
      aggregateId: snap.aggregateId,
      version: snap.version,
      blockHeight: snap.blockHeight,
      payload: snap.payload,
    };
  }

  public async applyEventsToAggregate<K extends T>(model: K, fromVersion?: number): Promise<void> {
    const table = model.aggregateId!;
    const since = fromVersion ?? 0;

    const rows = (await this.dataSource.query(
      `SELECT "type","requestId","blockHeight","payload","isCompressed","version","timestamp"
       FROM "${table}"
       WHERE "version" > ?
       ORDER BY "version" ASC`,
      [since]
    )) as Array<{
      type: string;
      requestId: string;
      blockHeight: number | null;
      payload: Buffer;
      isCompressed: number | boolean;
      version: number;
      timestamp: number;
    }>;

    const history: DomainEvent[] = [];
    for (const r of rows) {
      history.push(
        await deserializeToDomainEvent(
          table,
          {
            type: r.type,
            requestId: r.requestId,
            blockHeight: r.blockHeight!,
            payload: toBuffer(r.payload),
            isCompressed: !!r.isCompressed,
            version: r.version,
            timestamp: r.timestamp,
          },
          'sqljs'
        )
      );
    }

    model.loadFromHistory(history);
  }

  public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) {
      return;
    }
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      for (const id of aggregateIds) {
        await qr.manager.query(`DELETE FROM "snapshots" WHERE "aggregateId" = ? AND "blockHeight" = ?`, [
          id,
          blockHeight,
        ]);
      }
      await qr.query('COMMIT');
      await this.persistToDiskIfSupported();
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }
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

    if (rows.length <= minKeep) {
      return;
    }

    const toKeep = new Set<number>();
    for (let i = 0; i < Math.min(minKeep, rows.length); i++) {
      toKeep.add(rows[i]!.id);
    }
    for (const r of rows) {
      if (r.blockHeight >= protectFrom) {
        toKeep.add(r.id);
      }
    }

    const toDelete = rows.filter((r) => !toKeep.has(r.id)).map((r) => r.id);
    if (toDelete.length === 0) {
      return;
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      const step = BrowserSqljsAdapter.DELETE_ID_CHUNK;
      for (let i = 0; i < toDelete.length; i += step) {
        const chunk = toDelete.slice(i, i + step);
        const placeholders = chunk.map(() => '?').join(',');
        await qr.manager.query(`DELETE FROM "snapshots" WHERE "id" IN (${placeholders})`, chunk);
      }
      await qr.query('COMMIT');
      await this.persistToDiskIfSupported();
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }
  }

  public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    await this.dataSource.query(`DELETE FROM "${aggregateId}" WHERE "blockHeight" <= ?`, [pruneToBlockHeight]);
    await this.persistToDiskIfSupported();
  }

  public async rehydrateAtHeight<K extends T>(model: K, blockHeight: number): Promise<void> {
    // 1) Load snapshot ≤ height
    const snap = await this.createSnapshotAtHeight(model, blockHeight);
    model.fromSnapshot({
      aggregateId: snap.aggregateId,
      version: snap.version,
      blockHeight: snap.blockHeight,
      payload: snap.payload,
    });

    // 2) Apply events in (snap.blockHeight, height]
    const table = model.aggregateId!;
    const rows = (await this.dataSource.query(
      `SELECT "type","requestId","blockHeight","payload","isCompressed","version","timestamp"
       FROM "${table}"
       WHERE "blockHeight" IS NOT NULL AND "blockHeight" > ? AND "blockHeight" <= ?
       ORDER BY "version" ASC`,
      [snap.blockHeight, blockHeight]
    )) as Array<{
      type: string;
      requestId: string;
      blockHeight: number | null;
      payload: Buffer;
      isCompressed: number | boolean;
      version: number;
      timestamp: number;
    }>;

    const history: DomainEvent[] = [];
    for (const r of rows) {
      history.push(
        await deserializeToDomainEvent(
          table,
          {
            type: r.type,
            requestId: r.requestId,
            blockHeight: r.blockHeight!,
            payload: toBuffer(r.payload),
            isCompressed: !!r.isCompressed,
            version: r.version,
            timestamp: r.timestamp,
          },
          'sqljs'
        )
      );
    }

    model.loadFromHistory(history);
  }

  public async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) {
      return;
    }
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN'); // sql.js supports plain BEGIN
    try {
      // 1) Per-aggregate event tables
      for (const id of aggregateIds) {
        await qr.manager.query(`DELETE FROM "${id}" WHERE "blockHeight" > ?`, [blockHeight]);
      }

      // 2) Snapshots after the rollback height
      const placeholders = aggregateIds.map(() => '?').join(',');
      await qr.manager.query(`DELETE FROM "snapshots" WHERE "blockHeight" > ? AND "aggregateId" IN (${placeholders})`, [
        blockHeight,
        ...aggregateIds,
      ]);

      // 3) Outbox: clear completely (safer in browser after reorg)
      await qr.manager.query(`DELETE FROM "outbox"`);

      await qr.query('COMMIT');
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }

    // Reset streaming watermark
    this.lastSeenId = 0n;

    // Ensure in-memory DB is flushed to IndexedDB after destructive ops
    await this.persistToDiskIfSupported();
  }

  public async fetchEventsForAggregates(
    aggregateIds: string[],
    options?: { version?: number; blockHeight?: number; limit?: number; offset?: number }
  ): Promise<DomainEvent[]> {
    const out: DomainEvent[] = [];
    const { version, blockHeight, limit, offset } = options ?? {};

    for (const id of aggregateIds) {
      const conds: string[] = [];
      const params: Array<string | number | Buffer> = [];

      if (version != null) {
        conds.push(`"version" = ?`);
        params.push(version);
      }
      if (blockHeight != null) {
        conds.push(`"blockHeight" = ?`);
        params.push(blockHeight);
      }

      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const limitSql = limit != null ? `LIMIT ${Number(limit)}` : '';
      const offsetSql = offset != null ? `OFFSET ${Number(offset)}` : '';

      const rows = (await this.dataSource.query(
        `SELECT "type","requestId","blockHeight","payload","isCompressed","version","timestamp"
         FROM "${id}"
         ${whereSql}
         ORDER BY "version" ASC
         ${limitSql}
         ${offsetSql}`,
        params
      )) as Array<{
        type: string;
        requestId: string;
        blockHeight: number | null;
        payload: Buffer;
        isCompressed: number | boolean;
        version: number;
        timestamp: number;
      }>;

      for (const r of rows) {
        out.push(
          await deserializeToDomainEvent(
            id,
            {
              type: r.type,
              requestId: r.requestId,
              blockHeight: r.blockHeight!,
              payload: toBuffer(r.payload),
              isCompressed: !!r.isCompressed,
              version: r.version,
              timestamp: r.timestamp,
            },
            'sqljs'
          )
        );
      }
    }

    // Stable sort by (timestamp, version) for deterministic return order.
    out.sort((a: any, b: any) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return (a.version ?? 0) - (b.version ?? 0);
    });

    return out;
  }

  // ─────────────────────────── SQL.JS PERSISTENCE ───────────────────────────

  /**
   * Force-persist the in-memory sql.js database to IndexedDB (if configured).
   * TypeORM sets up the persistence when `useLocalForage: true` and `location` are provided.
   * We call driver’s `autoSaveCallback` if present to flush immediately after COMMIT.
   */
  private async persistToDiskIfSupported(): Promise<void> {
    const anyDs = this.dataSource as any;
    const driver = anyDs?.driver;
    const db = driver?.databaseConnection;
    const autoSaveCallback = driver?.autoSaveCallback;

    // sql.js TypeORM driver exposes autoSaveCallback when useLocalForage=true.
    if (typeof autoSaveCallback === 'function') {
      try {
        await autoSaveCallback(db);
      } catch {
        // Non-fatal: best-effort flush; next ops will try again.
      }
    }
  }
}
