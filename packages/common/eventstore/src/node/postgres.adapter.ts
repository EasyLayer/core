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
 * Postgres adapter.
 *
 * Design notes:
 * - Never calls aggregate.apply(); only aggregate.loadFromHistory().
 * - Uses project serializers/deserializers exclusively (no ad-hoc JSON ops).
 * - Payload is stored as bytea in both per-aggregate tables and the outbox.
 * - Outbox ordering is by a client-generated BIGINT PRIMARY KEY "id" (monotonic).
 * - PG handles boolean natively; we bind booleans as true/false.
 * - We avoid RETURNING because we already know the id; one less round trip.
 * - Delivery chunk sizing is computed locally from the provided transport cap:
 *     prefetch LIMIT ~ cap / AVG_EVENT_BYTES_GUESS (clamped) and then greedily
 *     accumulate by (FIXED_OVERHEAD + payload_uncompressed_bytes).
 */
export class PostgresAdapter<T extends AggregateRoot = AggregateRoot> extends BaseAdapter<T> {
  private deliverLock = new Mutex();
  /** Outbox delivery watermark (strictly increasing). */
  private lastSeenId = 0n;

  /** Delete IN() chunk size to keep packets under driver param/packet limits. */
  private static readonly DELETE_ID_CHUNK = 50_000;

  /** Prefetch tuning for PG (larger is fine compared to SQLite). */
  private static readonly FIXED_OVERHEAD = 256; // per-event wire envelope approx (bytes)
  private static readonly AVG_EVENT_BYTES_GUESS = 8 * 1024;
  private static readonly MIN_PREFETCH_ROWS = 1_024;
  private static readonly MAX_PREFETCH_ROWS = 32_768;

  // ─────────────────────────────── WRITE PATH ───────────────────────────────

  /**
   * Persist unsaved events of each aggregate into:
   *   1) per-aggregate event table (bytea payload)
   *   2) outbox (bytea payload) — with client-generated monotonic BIGINT id
   *
   * Returns the inserted outbox ids, first/last (id & timestamp) for compatibility,
   * and a raw array suitable for fast-path publish (same bytes as in DB).
   */
  public async persistAggregatesAndOutbox(aggregates: T[]): Promise<{
    insertedOutboxIds: string[]; // numeric view (safe while ids < 2^53); keep as string if you prefer
    firstTs: number;
    firstId: string;
    lastTs: number;
    lastId: string;
    rawEvents: WireEventRecord[];
    avgUncompressedBytes?: number;
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

        const unsaved: DomainEvent[] = agg.getUnsavedEvents();
        if (unsaved.length === 0) {
          continue;
        }

        // First version for these unsaved events = agg.version - unsaved.length + 1
        const startVersion = agg.version - unsaved.length + 1;

        for (let i = 0; i < unsaved.length; i++) {
          const ev = unsaved[i] as DomainEvent;
          const version = startVersion + i;

          // Serialize once; driver tag 'postgres' enables compression heuristics in serializers.
          const row = await toEventDataModel(ev, version, 'postgres');

          // Generate monotonic outbox id from event.timestamp.
          const newId = this.idGen.next(ev.timestamp!);

          // (1) Insert into per-aggregate table (bytea payload).
          await qr.manager.query(
            `INSERT INTO "${table}"
               ("version","requestId","type","payload","blockHeight","isCompressed","timestamp")
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT ("version","requestId") DO NOTHING`,
            [
              row.version,
              row.requestId,
              row.type,
              row.payload, // bytea
              row.blockHeight,
              row.isCompressed, // boolean
              row.timestamp,
            ]
          );

          // (2) Insert into outbox with our precomputed BIGINT id.
          await qr.manager.query(
            `INSERT INTO "outbox"
               ("id","aggregateId","eventType","eventVersion","requestId","blockHeight","payload","isCompressed","timestamp","payload_uncompressed_bytes")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT ON CONSTRAINT "UQ_outbox_aggregate_version" DO NOTHING`,
            [
              newId.toString(), // bind as string; PG BIGINT friendly
              table,
              row.type,
              row.version,
              row.requestId,
              row.blockHeight,
              row.payload, // same bytea
              row.isCompressed, // boolean
              row.timestamp,
              // if you track uncompressed size separately, pass it here; otherwise null/undefined is fine
            ]
          );

          // Track id bounds & timestamps for compatibility.
          if (firstIdBn === null || newId < firstIdBn) firstIdBn = newId;
          if (lastIdBn === null || newId > lastIdBn) lastIdBn = newId;
          if (ev.timestamp! < firstTs) firstTs = ev.timestamp!;
          if (ev.timestamp! > lastTs) lastTs = ev.timestamp!;

          // Build RAW wire record (no JSON parse — deserializer returns string payload).
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

        // Clear unsaved events after a successful flush for this aggregate.
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
        // Optionally, you can compute avgUncompressedBytes here if you track it.
      };
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }
  }

  public async deleteOutboxByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      const step = PostgresAdapter.DELETE_ID_CHUNK;
      for (let i = 0; i < ids.length; i += step) {
        const chunk = ids.slice(i, i + step).map((x) => x.toString());
        const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
        await qr.manager.query(`DELETE FROM "outbox" WHERE "id" IN (${placeholders})`, chunk);
      }
      await qr.query('COMMIT');
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }
  }

  public async rollbackAggregates(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) return;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN'); // PG transactional block
    try {
      // 1) Per-aggregate event tables: drop everything above the given block height
      for (const id of aggregateIds) {
        await qr.manager.query(`DELETE FROM "${id}" WHERE "blockHeight" > $1`, [blockHeight]);
      }

      // 2) Snapshots: remove snapshots created after the rollback height for these aggregates
      const placeholders = aggregateIds.map((_, i) => `$${i + 2}`).join(',');
      await qr.manager.query(
        `DELETE FROM "snapshots" WHERE "blockHeight" > $1 AND "aggregateId" IN (${placeholders})`,
        [blockHeight, ...aggregateIds]
      );

      // 3) Outbox: drop everything — safer after a chain reorg; repopulation will happen naturally
      await qr.manager.query(`TRUNCATE TABLE "outbox"`);

      await qr.query('COMMIT');
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }

    // Reset streaming watermark so the next drain starts fresh
    this.lastSeenId = 0n;
  }

  // ─────────────────────────────── BACKLOG TESTS ───────────────────────────────

  public async hasBacklogBefore(_ts: number, id: string): Promise<boolean> {
    const rows = await this.dataSource.query(`SELECT 1 FROM "outbox" WHERE id < $1::bigint LIMIT 1`, [String(id)]);
    return rows.length > 0;
  }

  public async hasAnyPendingAfterWatermark(): Promise<boolean> {
    const rows = await this.dataSource.query(`SELECT 1 FROM "outbox" WHERE id > $1::bigint LIMIT 1`, [
      String(this.lastSeenId),
    ]);
    return rows.length > 0;
  }

  // ─────────────────────────────── DELIVER / ACK ───────────────────────────────

  /**
   * Delivery strategy (Postgres):
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
      const wantRows = Math.max(1, Math.floor(transportCapBytes / PostgresAdapter.AVG_EVENT_BYTES_GUESS));
      const scanLimit = Math.max(
        PostgresAdapter.MIN_PREFETCH_ROWS,
        Math.min(PostgresAdapter.MAX_PREFETCH_ROWS, wantRows)
      );

      const rows = (await this.dataSource.query(
        `SELECT id,
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
         WHERE id > $1::bigint
         ORDER BY id ASC
         LIMIT ${scanLimit}`,
        [String(this.lastSeenId)]
      )) as Array<{
        id: string; // BIGINT comes as string from PG driver
        aggregateId: string;
        eventType: string;
        eventVersion: number;
        requestId: string;
        blockHeight: number | null;
        payload: Buffer;
        isCompressed: boolean;
        timestamp: number;
        ulen: number;
      }>;

      if (rows.length === 0) return 0;

      // Pick first K rows that fit the transport budget (always at least one).
      const accepted: typeof rows = [];
      let running = 0;

      for (const r of rows) {
        const add = PostgresAdapter.FIXED_OVERHEAD + Number(r.ulen);
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
      const ids = accepted.map((r) => r.id);
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.query('BEGIN');
      try {
        const step = 10000;
        for (let i = 0; i < ids.length; i += step) {
          const chunk = ids.slice(i, i + step).map((x) => String(x).trim());
          const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
          await qr.manager.query(`DELETE FROM "outbox" WHERE id IN (${placeholders})`, chunk);
        }
        await qr.query('COMMIT');
      } catch (e) {
        await qr.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await qr.release().catch(() => undefined);
      }

      this.lastSeenId = nextId;

      return events.length;
    });
  }

  // ─────────────────────────────── SNAPSHOTS / READ PATH ───────────────────────────────

  public async createSnapshot(aggregate: T, opts: SnapshotOptions): Promise<void> {
    const row = await toSnapshotDataModel(aggregate, 'postgres');
    await this.dataSource.query(
      `INSERT INTO "snapshots" ("aggregateId","blockHeight","version","payload","isCompressed")
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT ON CONSTRAINT "UQ_aggregate_blockheight" DO NOTHING`,
      [row.aggregateId, row.blockHeight, row.version, row.payload, row.isCompressed]
    );

    // Prune only if the aggregate explicitly allows pruning.
    const allow = (aggregate as any).allowPruning === true;
    if (allow) {
      await this.pruneOldSnapshots(row.aggregateId, row.blockHeight, opts);
    }
  }

  /** Return latest snapshot row (full DB row) for aggregateId. */
  public async findLatestSnapshot(aggregateId: string): Promise<SnapshotDataModel | null> {
    const rows = await this.dataSource.query(
      `SELECT "id","aggregateId","blockHeight","version","payload","isCompressed","createdAt"
       FROM "snapshots"
       WHERE "aggregateId" = $1
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [aggregateId]
    );
    if (rows.length === 0) return null;

    return {
      id: String(rows[0].id ?? '0'),
      aggregateId: rows[0].aggregateId,
      blockHeight: Number(rows[0].blockHeight),
      version: Number(rows[0].version),
      payload: rows[0].payload,
      isCompressed: !!rows[0].isCompressed,
      createdAt: rows[0].createdAt ?? new Date().toISOString(),
    };
  }

  /** Return latest snapshot row (full DB row) ≤ given height. */
  public async findLatestSnapshotBeforeHeight(aggregateId: string, height: number): Promise<SnapshotDataModel | null> {
    const rows = await this.dataSource.query(
      `SELECT "id","aggregateId","blockHeight","version","payload","isCompressed","createdAt"
       FROM "snapshots"
       WHERE "aggregateId" = $1 AND "blockHeight" <= $2
       ORDER BY "blockHeight" DESC
       LIMIT 1`,
      [aggregateId, height]
    );
    if (rows.length === 0) return null;

    return {
      id: String(rows[0].id ?? '0'),
      aggregateId: rows[0].aggregateId,
      blockHeight: Number(rows[0].blockHeight),
      version: Number(rows[0].version),
      payload: rows[0].payload,
      isCompressed: !!rows[0].isCompressed,
      createdAt: rows[0].createdAt ?? new Date().toISOString(),
    };
  }

  /**
   * Stream events and apply them to the model using the DataSource QueryRunner.
   * IMPORTANT:
   * - Process *one row at a time* and call model.loadFromHistory([event]) immediately.
   * - If `blockHeight` is provided → only finalized events with height ≤ H (exclude NULL).
   * - If undefined → apply all tail events regardless of height (include NULL).
   * - Strict version ASC order; streaming minimizes memory usage.
   */
  public async applyEventsToAggregate({
    model,
    blockHeight,
    lastVersion = 0,
  }: {
    model: T;
    blockHeight?: number;
    lastVersion?: number;
  }): Promise<void> {
    const table = model.aggregateId!;
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      const where =
        blockHeight == null
          ? `WHERE "version" > $1`
          : `WHERE "version" > $1 AND "blockHeight" IS NOT NULL AND "blockHeight" <= $2`;
      const params = blockHeight == null ? [lastVersion] : [lastVersion, blockHeight];

      const sql = `
        SELECT "type","requestId","blockHeight","payload","isCompressed","version","timestamp"
        FROM "${table}"
        ${where}
        ORDER BY "version" ASC
      `;

      // TypeORM QueryRunner.stream → Node Readable of row objects.
      const stream: NodeJS.ReadableStream = await qr.stream(sql, params);

      // Apply each event immediately to avoid buffering.
      for await (const r of stream as AsyncIterable<any>) {
        const ev = await toDomainEvent(table, {
          type: r.type,
          requestId: r.requestId,
          blockHeight: r.blockHeight,
          payload: r.payload,
          isCompressed: !!r.isCompressed,
          version: r.version,
          timestamp: r.timestamp,
        });
        // Apply single event at a time.
        model.loadFromHistory([ev]);
      }
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  public async deleteSnapshotsByBlockHeight(aggregateIds: string[], blockHeight: number): Promise<void> {
    if (aggregateIds.length === 0) return;
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      for (const id of aggregateIds) {
        await qr.manager.query(`DELETE FROM "snapshots" WHERE "aggregateId" = $1 AND "blockHeight" = $2`, [
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
       WHERE "aggregateId" = $1
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

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query('BEGIN');
    try {
      const step = PostgresAdapter.DELETE_ID_CHUNK;
      for (let i = 0; i < toDelete.length; i += step) {
        const chunk = toDelete.slice(i, i + step);
        const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
        await qr.manager.query(`DELETE FROM "snapshots" WHERE "id" IN (${placeholders})`, chunk);
      }
      await qr.query('COMMIT');
    } catch (e) {
      await qr.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await qr.release();
    }
  }

  public async pruneEvents(aggregateId: string, pruneToBlockHeight: number): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "${aggregateId}" WHERE "blockHeight" IS NOT NULL AND "blockHeight" <= $1`,
      [pruneToBlockHeight]
    );
  }

  /** Mutate model into state at given blockHeight (snapshot ≤ H + events to H). */
  public async restoreExactStateAtHeight(model: T, blockHeight: number): Promise<void> {
    const snap = await this.findLatestSnapshotBeforeHeight(model.aggregateId, blockHeight);
    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap, 'postgres');
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, blockHeight, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model, blockHeight });
    }
  }

  /** Latest state: snapshot (if any) + tail events (no height cap). */
  public async restoreExactStateLatest(model: T): Promise<void> {
    const snap = await this.findLatestSnapshot(model.aggregateId);
    if (snap) {
      const parsed = await toSnapshotParsedPayload(snap, 'postgres');
      model.fromSnapshot(parsed);
      await this.applyEventsToAggregate({ model, lastVersion: parsed.version });
    } else {
      await this.applyEventsToAggregate({ model });
    }
  }

  // ─────────────────────────────── READ API (events → JSON string) ───────────────────────────────

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

    const orderCol = orderBy === 'createdAt' ? `"timestamp"` : `"version"`;
    const orderDirSql = orderDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limSql = limit != null ? `LIMIT ${Number(limit)}` : 'LIMIT 100';
    const offSql = offset != null ? `OFFSET ${Number(offset)}` : '';

    for (const id of aggregateIds) {
      const conds: string[] = [];
      const params: any[] = [];

      if (versionGte != null) {
        conds.push(`"version" >= $${params.length + 1}`);
        params.push(versionGte);
      }
      if (versionLte != null) {
        conds.push(`"version" <= $${params.length + 1}`);
        params.push(versionLte);
      }

      if (heightGte != null) {
        conds.push(`"blockHeight" IS NOT NULL AND "blockHeight" >= $${params.length + 1}`);
        params.push(heightGte);
      }
      if (heightLte != null) {
        conds.push(`"blockHeight" IS NOT NULL AND "blockHeight" <= $${params.length + 1}`);
        params.push(heightLte);
      }

      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const sql = `
        SELECT "type","payload","version","requestId","blockHeight","timestamp","isCompressed"
        FROM "${id}"
        ${whereSql}
        ORDER BY ${orderCol} ${orderDirSql}
        ${limSql}
        ${offSql}
      `;

      const rows = await this.dataSource.query(sql, params);

      for (let r of rows) {
        out.push(await toEventReadRow(id, r, 'postgres'));
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

  // ─────────────────────────────── STREAM READ API (Postgres only) ───────────────────────────────

  /** Stream events for ONE aggregate as JSON-string DTOs via DataSource QueryRunner. */
  public async *streamEventsForOneAggregateRead(
    aggregateId: string,
    options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    const { versionGte, versionLte, heightGte, heightLte, orderBy = 'version', orderDir = 'asc' } = options;

    const orderCol = orderBy === 'createdAt' ? `"timestamp"` : `"version"`;
    const orderDirSql = orderDir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const conds: string[] = [];
    const params: any[] = [];

    if (versionGte != null) {
      conds.push(`"version" >= $${params.length + 1}`);
      params.push(versionGte);
    }
    if (versionLte != null) {
      conds.push(`"version" <= $${params.length + 1}`);
      params.push(versionLte);
    }

    if (heightGte != null) {
      conds.push(`"blockHeight" IS NOT NULL AND "blockHeight" >= $${params.length + 1}`);
      params.push(heightGte);
    }
    if (heightLte != null) {
      conds.push(`"blockHeight" IS NOT NULL AND "blockHeight" <= $${params.length + 1}`);
      params.push(heightLte);
    }

    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const sql = `
      SELECT "type","payload","version","requestId","blockHeight","timestamp","isCompressed"
      FROM "${aggregateId}"
      ${whereSql}
      ORDER BY ${orderCol} ${orderDirSql}
    `;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      const stream: NodeJS.ReadableStream = await qr.stream(sql, params);

      for await (const r of stream as AsyncIterable<any>) {
        // Map each DB row → EventReadRow (payload as JSON string; no JSON.parse here)
        const dto = await toEventReadRow(aggregateId, r as EventDataModel, 'postgres');
        yield dto;
      }
    } finally {
      await qr.release().catch(() => undefined);
    }
  }

  /** Stream events for MANY aggregates one by one. */
  public async *streamEventsForManyAggregatesRead(
    aggregateIds: string[],
    options: FindEventsOptions = {}
  ): AsyncGenerator<EventReadRow, void, unknown> {
    for (const id of aggregateIds) {
      for await (const row of this.streamEventsForOneAggregateRead(id, options)) {
        yield row;
      }
    }
  }

  // ─────────────────────────────── MODEL READ AT HEIGHT ───────────────────────────────

  public async getOneModelByHeightRead(model: T, blockHeight: number): Promise<SnapshotReadRow | null> {
    const id = model.aggregateId;
    if (!id) return null;
    await this.restoreExactStateAtHeight(model, blockHeight);
    return toSnapshotReadRow(model);
  }

  public async getManyModelsByHeightRead(models: T[], blockHeight: number): Promise<SnapshotReadRow[]> {
    if (!models.length) return [];
    const out: SnapshotReadRow[] = [];
    for (const m of models) {
      const row = await this.getOneModelByHeightRead(m, blockHeight);
      if (row) out.push(row);
    }
    return out;
  }
}
