import "reflect-metadata";
import { DataSource } from "typeorm";
import { createOutboxEntity } from "../../outbox.model";
import { createEventDataEntity } from "../../event-data.model";
import { createSnapshotsEntity } from "../../snapshots.model";
import type { DomainEvent } from "@easylayer/common/cqrs";
import { AggregateRoot } from "@easylayer/common/cqrs";
import { SqliteAdapter } from "../../../node/sqlite.adapter";

class TestEvent implements DomainEvent<any> {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  timestamp: number;
  payload: any;
  constructor(aid: string, rid: string, bh: number, payload: any) {
    this.aggregateId = aid;
    this.requestId = rid;
    this.blockHeight = bh;
    this.timestamp = Date.now() * 1000 + Math.floor(Math.random() * 100);
    this.payload = payload;
  }
}

class TestAgg extends AggregateRoot<DomainEvent> {
  private v: number;
  constructor(id: string, last: number, version = 0) {
    super(id, last);
    this.v = version;
  }
  override get version(): number {
    return this.v;
  }
  addUnsaved(ev: DomainEvent) {
    this.apply(ev, { fromHistory: false, skipHandler: true });
  }
}

async function makeSqliteDS(aggregateIds: string[]) {
  const entities = [
    createOutboxEntity("sqlite"),
    ...aggregateIds.map((id) => createEventDataEntity(id, "sqlite")),
    createSnapshotsEntity("sqlite"),
  ];
  const ds = new DataSource({
    type: "sqlite",
    database: ":memory:",
    entities,
    synchronize: true,
  } as any);
  await ds.initialize();
  return ds;
}

function toBigIntIds(ids: string[]) {
  return ids.map((s) => BigInt(s));
}

describe("SqliteAdapter", () => {
  let ds: DataSource;
  let adapter: SqliteAdapter;

  afterEach(async () => {
    if (ds && ds.isInitialized) {
      await ds.destroy();
    }
  });

  it("persistAggregatesAndOutbox: outbox ids strictly increase in one tx; rows match order", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    const a = new TestAgg("agg1", 0, 0);
    a.addUnsaved(new TestEvent("agg1", "r1", 1, { x: 1 }));
    a.addUnsaved(new TestEvent("agg1", "r2", 2, { x: 2 }));
    a.addUnsaved(new TestEvent("agg1", "r3", 3, { x: 3 }));

    const persisted = await adapter.persistAggregatesAndOutbox([a]);
    expect(persisted.insertedOutboxIds.length).toBe(3);

    const ids = toBigIntIds(persisted.insertedOutboxIds);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }

    const rows = await ds.query(`SELECT CAST(id AS TEXT) AS id FROM outbox ORDER BY id ASC`);
    const rowIds: string[] = rows.map((r: any) => r.id);
    expect(rowIds).toEqual(persisted.insertedOutboxIds);
  });

  it("two subsequent persists produce disjoint, increasing id ranges", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    const a = new TestAgg("agg1", 0, 0);
    a.addUnsaved(new TestEvent("agg1", "r1", 1, { x: 1 }));
    a.addUnsaved(new TestEvent("agg1", "r2", 2, { x: 2 }));
    const p1 = await adapter.persistAggregatesAndOutbox([a]);

    const b = new TestAgg("agg1", 2, 2);
    b.addUnsaved(new TestEvent("agg1", "r3", 3, { x: 3 }));
    b.addUnsaved(new TestEvent("agg1", "r4", 4, { x: 4 }));
    const p2 = await adapter.persistAggregatesAndOutbox([b]);

    const last1 = BigInt(p1.insertedOutboxIds[p1.insertedOutboxIds.length - 1]!);
    const first2 = BigInt(p2.insertedOutboxIds[0]!);
    expect(first2 > last1).toBe(true);

    const allIds = [...p1.insertedOutboxIds, ...p2.insertedOutboxIds];
    const rows = await ds.query(`SELECT CAST(id AS TEXT) AS id FROM outbox ORDER BY id ASC`);
    const rowIds: string[] = rows.map((r: any) => r.id);
    expect(rowIds).toEqual(allIds);
  });

  it("persistAggregatesAndOutbox returns rawEvents for fast-path; deleteOutboxByIds removes only just-inserted", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    const old = new TestAgg("agg1", 0, 0);
    old.addUnsaved(new TestEvent("agg1", "old1", 1, { o: 1 }));
    await adapter.persistAggregatesAndOutbox([old]);

    const a = new TestAgg("agg1", 1, 1);
    a.addUnsaved(new TestEvent("agg1", "r1", 2, { x: 1 }));
    a.addUnsaved(new TestEvent("agg1", "r2", 3, { x: 2 }));

    const persisted = await adapter.persistAggregatesAndOutbox([a]);
    expect(persisted.rawEvents.length).toBe(2);

    const beforeRows = await ds.query(`SELECT CAST(id AS TEXT) AS id FROM outbox ORDER BY id ASC`);
    const beforeIds: string[] = beforeRows.map((r: any) => r.id);

    await adapter.deleteOutboxByIds(persisted.insertedOutboxIds);

    const afterRows = await ds.query(`SELECT CAST(id AS TEXT) AS id FROM outbox ORDER BY id ASC`);
    const afterIds: string[] = afterRows.map((r: any) => r.id);

    for (const id of persisted.insertedOutboxIds) {
      expect(afterIds).not.toContain(id);
    }
    const remaining = beforeIds.filter((id) => !persisted.insertedOutboxIds.includes(id));
    expect(afterIds).toEqual(remaining);
  });

  it("fetchDeliverAckChunk: success deletes delivered rows; failure keeps them", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    const a = new TestAgg("agg1", 0, 0);
    for (let i = 1; i <= 5; i++) {
      a.addUnsaved(new TestEvent("agg1", "r" + i, i, { x: i }));
    }
    await adapter.persistAggregatesAndOutbox([a]);

    const totalBefore = (await ds.query(`SELECT COUNT(*) AS c FROM outbox`))[0].c as number;

    await expect(
      adapter.fetchDeliverAckChunk(1_000_000, async (_evs) => {
        throw new Error("publish-failed");
      })
    ).rejects.toThrow(/publish-failed/);
    const afterFail = (await ds.query(`SELECT COUNT(*) AS c FROM outbox`))[0].c as number;
    expect(afterFail).toBe(totalBefore);

    const sent = await adapter.fetchDeliverAckChunk(1_000_000, async (_evs) => Promise.resolve());
    expect(sent).toBeGreaterThan(0);
    const afterSuccess = (await ds.query(`SELECT COUNT(*) AS c FROM outbox`))[0].c as number;
    expect(afterSuccess).toBeLessThan(afterFail);
  });

  it("fetchDeliverAckChunk respects chunking (no duplicates across calls, drains to zero)", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    const a = new TestAgg("agg1", 0, 0);
    for (let i = 1; i <= 10; i++) {
      a.addUnsaved(new TestEvent("agg1", "r" + i, i, { payload: "x".repeat(200) }));
    }
    await adapter.persistAggregatesAndOutbox([a]);

    let sent = 0;
    while (true) {
      const n = await adapter.fetchDeliverAckChunk(2_000, async (evs) => {
        sent += evs.length;
      });
      if (n === 0) break;
    }
    expect(sent).toBe(10);
    const left = (await ds.query(`SELECT COUNT(*) AS c FROM outbox`))[0].c as number;
    expect(left).toBe(0);
  });

  it("hasBacklogBefore detects older backlog prior to our first watermark", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    const older = new TestAgg("agg1", 0, 0);
    older.addUnsaved(new TestEvent("agg1", "old1", 1, { z: 1 }));
    const p1 = await adapter.persistAggregatesAndOutbox([older]);

    const newer = new TestAgg("agg1", 1, 1);
    newer.addUnsaved(new TestEvent("agg1", "new1", 2, { z: 2 }));
    const p2 = await adapter.persistAggregatesAndOutbox([newer]);

    const hasBefore = await adapter.hasBacklogBefore(p2.firstTs, p2.firstId);
    expect(hasBefore).toBe(true);

    while ((await adapter.fetchDeliverAckChunk(1_000_000, async () => {})) > 0) {}
    const hasBeforeAfterDrain = await adapter.hasBacklogBefore(p2.firstTs, p2.firstId);
    expect(hasBeforeAfterDrain).toBe(false);

    expect(BigInt(p2.firstId) > BigInt(p1.firstId)).toBe(true);
  });

  it("hasAnyPendingAfterWatermark returns false when outbox empty, true when rows exist", async () => {
    ds = await makeSqliteDS(["agg1"]);
    adapter = new SqliteAdapter(ds);
    await adapter.onModuleInit?.();

    expect(await adapter.hasAnyPendingAfterWatermark()).toBe(false);

    const a = new TestAgg("agg1", 0, 0);
    a.addUnsaved(new TestEvent("agg1", "r1", 1, { x: 1 }));
    await adapter.persistAggregatesAndOutbox([a]);
    expect(await adapter.hasAnyPendingAfterWatermark()).toBe(true);

    while ((await adapter.fetchDeliverAckChunk(1_000_000, async () => {})) > 0) {}
    expect(await adapter.hasAnyPendingAfterWatermark()).toBe(false);
  });
});
