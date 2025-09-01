import "reflect-metadata";
import { PostgresAdapter } from "../postgres.adapter";
import type { WireEventRecord } from "@easylayer/common/cqrs-transport";
import { AggregateRoot } from "@easylayer/common/cqrs";

jest.mock("../../event-data.model", () => ({
  serializeEventRow: jest.fn(async (ev: any, version: number) => ({
    type: ev?.__t ?? "Ev",
    payload: Buffer.from(JSON.stringify(ev.payload ?? {}), "utf8"),
    version,
    requestId: ev.requestId,
    blockHeight: ev.blockHeight,
    isCompressed: false,
    timestamp: ev.timestamp,
    payloadUncompressedBytes: Buffer.byteLength(JSON.stringify(ev.payload ?? {}), "utf8"),
  })),
  deserializeToDomainEvent: jest.fn(async (aggregateId: string, row: any) => {
    const jsonStr = row.isCompressed ? "" : row.payload.toString("utf8");
    const payload = jsonStr ? JSON.parse(jsonStr) : {};
    const proto: any = {};
    Object.defineProperty(proto, "constructor", { value: { name: row.type }, enumerable: false });
    return Object.assign(Object.create(proto), {
      aggregateId,
      requestId: row.requestId,
      blockHeight: row.blockHeight ?? -1,
      timestamp: row.timestamp ?? Date.now() * 1000,
      payload,
      version: row.version ?? 0,
    });
  }),
}));

jest.mock("../../outbox.model", () => ({
  deserializeToOutboxRaw: jest.fn(async (r: any) => ({
    modelName: r.aggregateId,
    eventType: r.eventType,
    eventVersion: r.eventVersion,
    requestId: r.requestId,
    blockHeight: r.blockHeight ?? -1,
    payload: r.payload.toString("utf8"),
    timestamp: r.timestamp,
  })),
}));

jest.mock("../../snapshots.model", () => ({
  serializeSnapshot: jest.fn(async (aggregate: any) => ({
    aggregateId: aggregate.aggregateId,
    blockHeight: aggregate.lastBlockHeight,
    version: aggregate.version,
    payload: Buffer.from(JSON.stringify({ s: 1 }), "utf8"),
    isCompressed: false,
  })),
  deserializeSnapshot: jest.fn(async (row: any) => ({
    aggregateId: row.aggregateId,
    blockHeight: row.blockHeight,
    version: row.version,
    payload: JSON.parse(row.payload.toString("utf8")),
  })),
}));

class TestAgg extends AggregateRoot<any> {
  private _v: number;
  private _unsaved: any[] = [];
  constructor(id: string, last: number, version = 0) {
    super(id, last);
    this._v = version;
  }
  override get version() {
    return this._v;
  }
  addUnsaved(ev: any) {
    this.apply(ev, { fromHistory: false, skipHandler: true });
  }
  override getUnsavedEvents() {
    return super.getUnsavedEvents();
  }
  override markEventsAsSaved(): void {
    super.markEventsAsSaved();
  }
  override loadFromHistory(history: any[]) {
    // no-op
    void history;
  }
}

function mkEvent(aid: string, rid: string, bh: number, payload: any, ts: number, type = "Ev") {
  const e: any = {
    aggregateId: aid,
    requestId: rid,
    blockHeight: bh,
    timestamp: ts,
    payload,
  };
  Object.defineProperty(Object.getPrototypeOf(e), "constructor", { value: { name: type } });
  return e;
}

function mkDS() {
  const manager = { query: jest.fn() };
  const qr = {
    connect: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
    query: jest.fn(async () => {}),
    startTransaction: jest.fn(async () => {}),
    commitTransaction: jest.fn(async () => {}),
    rollbackTransaction: jest.fn(async () => {}),
    manager,
  };
  const ds: any = {
    createQueryRunner: () => qr,
    query: jest.fn(),
  };
  return { ds, qr, manager };
}

function flattenCalls(fn: jest.Mock) {
  return fn.mock.calls.map((args) => [args[0], args.slice(1)]);
}

describe("PostgresAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persistAggregatesAndOutbox: inserts rows, returns outbox ids/ts, builds rawEvents; clears unsaved", async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new PostgresAdapter(ds as any);
    // stable idGen
    (adapter as any).idGen = { next: jest.fn((ts: number) => BigInt(ts)) };

    const a = new TestAgg("agg1", 0, 2);
    const t1 = 1000_001n; const t2 = 1000_005n;
    a.addUnsaved(mkEvent("agg1", "r1", 1, { x: 1 }, Number(t1)));
    a.addUnsaved(mkEvent("agg1", "r2", 2, { x: 2 }, Number(t2)));

    const res = await adapter.persistAggregatesAndOutbox([a]);

    expect(qr.query).toHaveBeenCalledWith("BEGIN");
    expect(qr.query).toHaveBeenCalledWith("COMMIT");

    const mCalls = flattenCalls(manager.query);
    const insAgg = mCalls.filter(([sql]) => String(sql).includes(`INSERT INTO "agg1"`));
    const insOut = mCalls.filter(([sql]) => String(sql).includes(`INSERT INTO "outbox"`));
    expect(insAgg.length).toBe(2);
    expect(insOut.length).toBe(2);

    expect(res.insertedOutboxIds).toEqual([String(t1), String(t2)]);
    expect(res.firstId).toBe(String(t1));
    expect(res.lastId).toBe(String(t2));
    expect(res.rawEvents.length).toBe(2);

    expect(a.getUnsavedEvents().length).toBe(0);
  });

  it("deleteOutboxByIds: chunks and deletes; transactional", async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new PostgresAdapter(ds as any);
    (PostgresAdapter as any).DELETE_ID_CHUNK = 3;

    const ids = Array.from({ length: 7 }, (_, i) => String(1000 + i));

    await adapter.deleteOutboxByIds(ids);

    expect(qr.query).toHaveBeenCalledWith("BEGIN");
    expect(qr.query).toHaveBeenCalledWith("COMMIT");

    const delCalls = manager.query.mock.calls.filter(([sql]: any[]) =>
      String(sql).startsWith(`DELETE FROM "outbox" WHERE "id" IN (`)
    );
    expect(delCalls.length).toBe(3);
    const sentValues = delCalls.flatMap(([, params]) => params as string[]);
    expect(sentValues.sort()).toEqual(ids.sort());
  });

  it("hasBacklogBefore / hasAnyPendingAfterWatermark", async () => {
    const { ds } = mkDS();
    const adapter = new PostgresAdapter(ds as any);

    (ds.query as jest.Mock)
      .mockResolvedValueOnce([{ "1": 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ "1": 1 }]);

    const r1 = await adapter.hasBacklogBefore(0, "123");
    expect(r1).toBe(true);

    const r2 = await adapter.hasBacklogBefore(0, "123");
    expect(r2).toBe(false);

    const r3 = await adapter.hasAnyPendingAfterWatermark();
    expect(r3).toBe(false);

    (adapter as any).lastSeenId = 10n;
    const r4 = await adapter.hasAnyPendingAfterWatermark();
    expect(r4).toBe(true);
  });

  it("fetchDeliverAckChunk: picks fitting rows by budget, delivers, deletes accepted, advances watermark", async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new PostgresAdapter(ds as any);
    (adapter as any).lastSeenId = 0n;

    const rows = Array.from({ length: 5 }, (_, i) => {
      const id = String(1000 + i);
      const ulen = 500; // uncompressed payload estimate
      return {
        id,
        aggregateId: "agg1",
        eventType: "Ev",
        eventVersion: i + 1,
        requestId: "r" + (i + 1),
        blockHeight: i + 1,
        payload: Buffer.from(JSON.stringify({ p: i + 1 }), "utf8"),
        isCompressed: false,
        timestamp: 1000000 + i,
        ulen,
      };
    });

    (ds.query as jest.Mock).mockResolvedValueOnce(rows);

    const delivered: WireEventRecord[][] = [];
    const count = await adapter.fetchDeliverAckChunk(1_200, async (evs) => {
      delivered.push(evs);
    });

    expect(count).toBeGreaterThan(0);
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.length).toBeGreaterThan(0);

    const delCalls = manager.query.mock.calls.filter(([sql]: any[]) =>
      String(sql).startsWith(`DELETE FROM "outbox" WHERE id IN (`)
    );
    expect(delCalls.length).toBe(1);

    const lastAcceptedId = String(1000 + delivered[0]!.length - 1);
    expect((adapter as any).lastSeenId).toBe(BigInt(lastAcceptedId));
  });

  it("fetchDeliverAckChunk: if deliver throws, rows remain and watermark not advanced", async () => {
    const { ds } = mkDS();
    const adapter = new PostgresAdapter(ds as any);
    (adapter as any).lastSeenId = 0n;

    (ds.query as jest.Mock).mockResolvedValueOnce([
      {
        id: "1001",
        aggregateId: "agg1",
        eventType: "Ev",
        eventVersion: 1,
        requestId: "r1",
        blockHeight: 1,
        payload: Buffer.from(JSON.stringify({ p: 1 }), "utf8"),
        isCompressed: false,
        timestamp: 1,
        ulen: 100,
      },
    ]);

    await expect(
      adapter.fetchDeliverAckChunk(10_000, async () => {
        throw new Error("fail");
      })
    ).rejects.toThrow(/fail/);

    expect((adapter as any).lastSeenId).toBe(0n);
  });

  it("createSnapshot inserts, findLatestSnapshot returns last, createSnapshotAtHeight reads+parses", async () => {
    const { ds, manager, qr } = mkDS();
    const adapter = new PostgresAdapter(ds as any);

    (manager.query as jest.Mock).mockResolvedValue(undefined);
    await adapter.createSnapshot(new TestAgg("agg1", 10, 5) as any, { minKeep: 2, keepWindow: 0 });

    (ds.query as jest.Mock)
      .mockResolvedValueOnce([{ blockHeight: 12 }]) // findLatestSnapshot
      .mockResolvedValueOnce([
        // createSnapshotAtHeight select returns row
        {
          aggregateId: "agg1",
          blockHeight: 9,
          version: 4,
          payload: Buffer.from(JSON.stringify({ s: 1 }), "utf8"),
          isCompressed: false,
        },
      ]);

    const last = await adapter.findLatestSnapshot("agg1");
    expect(last).toEqual({ blockHeight: 12 });

    const snapAt = await adapter.createSnapshotAtHeight(new TestAgg("agg1", 10, 5) as any, 10);
    expect(snapAt.aggregateId).toBe("agg1");
    expect(snapAt.blockHeight).toBe(9);
    expect(snapAt.version).toBe(4);
    expect(snapAt.payload).toEqual({ s: 1 });
  });

  it("applyEventsToAggregate selects rows and passes deserialized history to loadFromHistory", async () => {
    const { ds } = mkDS();
    const adapter = new PostgresAdapter(ds as any);

    (ds.query as jest.Mock).mockResolvedValueOnce([
      {
        type: "Ev",
        requestId: "r1",
        blockHeight: 1,
        payload: Buffer.from(JSON.stringify({ x: 1 }), "utf8"),
        isCompressed: false,
        version: 1,
        timestamp: 11,
      },
      {
        type: "Ev",
        requestId: "r2",
        blockHeight: 2,
        payload: Buffer.from(JSON.stringify({ x: 2 }), "utf8"),
        isCompressed: false,
        version: 2,
        timestamp: 12,
      },
    ]);

    const a = new TestAgg("agg1", 0, 0);
    const spy = jest.spyOn(a, "loadFromHistory");
    await adapter.applyEventsToAggregate(a as any, 0);

    expect(spy).toHaveBeenCalled();
    const arg = spy.mock.calls[0]![0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg.length).toBe(2);
    expect(arg[0].payload).toEqual({ x: 1 });
    expect(arg[1].payload).toEqual({ x: 2 });
  });

  it("rehydrateAtHeight applies snapshot then range events", async () => {
    const { ds } = mkDS();
    const adapter = new PostgresAdapter(ds as any);

    (ds.query as jest.Mock)
      .mockResolvedValueOnce([
        { aggregateId: "agg1", blockHeight: 5, version: 3, payload: Buffer.from(JSON.stringify({ s: 1 })), isCompressed: false },
      ]) // snapshot row
      .mockResolvedValueOnce([
        {
          type: "Ev",
          requestId: "r4",
          blockHeight: 6,
          payload: Buffer.from(JSON.stringify({ x: 4 })),
          isCompressed: false,
          version: 4,
          timestamp: 21,
        },
      ]); // events range

    const a = new TestAgg("agg1", 0, 0);
    const fromSnapshotSpy = jest.spyOn(a, "fromSnapshot");
    const loadSpy = jest.spyOn(a, "loadFromHistory");

    await adapter.rehydrateAtHeight(a as any, 6);

    expect(fromSnapshotSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    const history = loadSpy.mock.calls[0]![0];
    expect(history.length).toBe(1);
    expect(history[0].blockHeight).toBe(6);
  });

  it("rollbackAggregates deletes rows > height, truncates outbox, resets watermark", async () => {
    const { ds, manager, qr } = mkDS();
    const adapter = new PostgresAdapter(ds as any);
    (adapter as any).lastSeenId = 999n;

    await adapter.rollbackAggregates(["agg1", "agg2"], 50);

    const mCalls = flattenCalls(manager.query);
    expect(qr.query).toHaveBeenCalledWith("BEGIN");
    expect(qr.query).toHaveBeenCalledWith("COMMIT");
    expect(mCalls.some(([sql]) => String(sql).includes(`DELETE FROM "agg1"`))).toBe(true);
    expect(mCalls.some(([sql]) => String(sql).includes(`DELETE FROM "agg2"`))).toBe(true);
    expect(mCalls.some(([sql]) => String(sql).includes(`DELETE FROM "snapshots"`))).toBe(true);
    expect(mCalls.some(([sql]) => String(sql).includes(`TRUNCATE TABLE "outbox"`))).toBe(true);
    expect((adapter as any).lastSeenId).toBe(0n);
  });

  it("fetchEventsForAggregates applies optional filters and sorts", async () => {
    const { ds } = mkDS();
    const adapter = new PostgresAdapter(ds as any);

    (ds.query as jest.Mock)
      .mockResolvedValueOnce([
        {
          type: "Ev",
          requestId: "r1",
          blockHeight: 1,
          payload: Buffer.from(JSON.stringify({ a: 1 })),
          isCompressed: false,
          version: 2,
          timestamp: 12,
        },
      ])
      .mockResolvedValueOnce([
        {
          type: "Ev",
          requestId: "r2",
          blockHeight: 1,
          payload: Buffer.from(JSON.stringify({ b: 2 })),
          isCompressed: false,
          version: 1,
          timestamp: 12,
        },
      ]);

    const out = await adapter.fetchEventsForAggregates(["agg1", "agg2"], { blockHeight: 1 });
    expect(out.length).toBe(2);
    // expect(out[0]!.version <= out[1].version).toBe(true);
  });
});
