import 'reflect-metadata';
import type { DomainEvent } from '@easylayer/common/cqrs';
import { AggregateRoot } from '@easylayer/common/cqrs';
import { SqliteAdapter } from '../sqlite.adapter';

jest.mock('../event-data.serialize', () => ({
  serializeEventRow: jest.fn(async (ev: any, version: number) => ({
    type: ev?.__t ?? 'Ev',
    payload: Buffer.from(JSON.stringify(ev.payload ?? {}), 'utf8'),
    version,
    requestId: ev.requestId,
    blockHeight: ev.blockHeight,
    isCompressed: false,
    timestamp: ev.timestamp,
    payloadUncompressedBytes: Buffer.byteLength(JSON.stringify(ev.payload ?? {}), 'utf8'),
  })),
  deserializeToDomainEvent: jest.fn(async (aggregateId: string, row: any) => {
    const jsonStr = row.isCompressed ? '' : row.payload.toString('utf8');
    const payload = jsonStr ? JSON.parse(jsonStr) : {};
    const proto: any = {};
    Object.defineProperty(proto, 'constructor', { value: { name: row.type }, enumerable: false });
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

jest.mock('../outbox.deserialize', () => ({
  deserializeToOutboxRaw: jest.fn(async (r: any) => ({
    modelName: r.aggregateId,
    eventType: r.eventType,
    eventVersion: r.eventVersion,
    requestId: r.requestId,
    blockHeight: r.blockHeight ?? -1,
    payload: r.payload.toString('utf8'),
    timestamp: r.timestamp,
  })),
}));

jest.mock('../snapshot.serialize', () => ({
  serializeSnapshot: jest.fn(async (aggregate: any) => ({
    aggregateId: aggregate.aggregateId,
    blockHeight: aggregate.lastBlockHeight,
    version: aggregate.version,
    payload: Buffer.from(JSON.stringify({ s: 1 }), 'utf8'),
    isCompressed: false,
  })),
  deserializeSnapshot: jest.fn(async (row: any) => ({
    aggregateId: row.aggregateId,
    blockHeight: row.blockHeight,
    version: row.version,
    payload: JSON.parse(row.payload.toString('utf8')),
  })),
}));

class TestEvent implements DomainEvent<any> {
  aggregateId: string;
  requestId: string;
  blockHeight: number;
  timestamp: number;
  payload: any;
  constructor(aid: string, rid: string, bh: number, payload: any, ts?: number) {
    this.aggregateId = aid;
    this.requestId = rid;
    this.blockHeight = bh;
    this.timestamp = ts ?? Date.now() * 1000 + Math.floor(Math.random() * 100);
    this.payload = payload;
  }
}

class TestAgg extends AggregateRoot<DomainEvent> {
  private v: number;
  constructor(id: string, last: number, version = 0) {
    super(id, last);
    this.v = version;
  }
  override get version(): number { return this.v; }
  addUnsaved(ev: DomainEvent) { this.apply(ev, { fromHistory: false, skipHandler: true }); }
}

function mkDS() {
  const manager = { query: jest.fn() };
  const qr = {
    connect: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
    query: jest.fn(async () => {}),
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

describe('SqliteAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('onModuleInit applies PRAGMAs', async () => {
    const { ds, qr } = mkDS();
    const adapter = new SqliteAdapter(ds as any);
    await adapter.onModuleInit?.();
    const s = (qr.query as jest.Mock).mock.calls.map(([sql]: any[]) => String(sql)).join('\n');
    expect(s).toMatch(/PRAGMA journal_mode/i);
    expect(s).toMatch(/PRAGMA synchronous/i);
    expect(s).toMatch(/PRAGMA busy_timeout/i);
    expect(s).toMatch(/PRAGMA locking_mode\s*=\s*EXCLUSIVE/i);
    expect(s).toMatch(/PRAGMA wal_autocheckpoint/i);
  });

  it('persistAggregatesAndOutbox inserts rows and returns ids/raw; clears unsaved', async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new SqliteAdapter(ds as any);
    (adapter as any).idGen = { next: jest.fn((ts: number) => BigInt(ts)) };

    const a = new TestAgg('agg1', 0, 2);
    const t1 = 1000_001n; const t2 = 1000_005n;
    a.addUnsaved(new TestEvent('agg1', 'r1', 1, { x: 1 }, Number(t1)));
    a.addUnsaved(new TestEvent('agg1', 'r2', 2, { x: 2 }, Number(t2)));

    const res = await adapter.persistAggregatesAndOutbox([a]);

    expect(qr.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');

    const m = flattenCalls(manager.query as any);
    const insAgg = m.filter(([sql]) => String(sql).includes(`INSERT OR IGNORE INTO "agg1"`));
    const insOut = m.filter(([sql]) => String(sql).includes(`INSERT OR IGNORE INTO "outbox"`));
    expect(insAgg.length).toBe(2);
    expect(insOut.length).toBe(2);

    expect(res.insertedOutboxIds).toEqual([String(t1), String(t2)]);
    expect(res.firstId).toBe(String(t1));
    expect(res.lastId).toBe(String(t2));
    expect(res.rawEvents.length).toBe(2);
    expect(a.getUnsavedEvents().length).toBe(0);
  });

  it('two persists produce disjoint increasing id ranges', async () => {
    const { ds, manager } = mkDS();
    const adapter = new SqliteAdapter(ds as any);
    (adapter as any).idGen = { next: jest.fn((((seq: any) => (ts: number) => BigInt(ts + (seq += 1))) as any)(0)) };

    const a = new TestAgg('agg1', 0, 0);
    a.addUnsaved(new TestEvent('agg1', 'r1', 1, { x: 1 }, 1000_000));
    a.addUnsaved(new TestEvent('agg1', 'r2', 2, { x: 2 }, 1000_010));
    const p1 = await adapter.persistAggregatesAndOutbox([a]);

    const b = new TestAgg('agg1', 2, 2);
    b.addUnsaved(new TestEvent('agg1', 'r3', 3, { x: 3 }, 1000_020));
    b.addUnsaved(new TestEvent('agg1', 'r4', 4, { x: 4 }, 1000_030));
    const p2 = await adapter.persistAggregatesAndOutbox([b]);

    const last1 = BigInt(p1.insertedOutboxIds[p1.insertedOutboxIds.length - 1]!);
    const first2 = BigInt(p2.insertedOutboxIds[0]!);
    expect(first2 > last1).toBe(true);

    const allIns = (manager.query as jest.Mock).mock.calls
      .map(([sql, params]: any[]) => String(sql).includes(`INSERT OR IGNORE INTO "outbox"`) ? String(params[0]) : null)
      .filter(Boolean);
    expect(allIns).toEqual([...p1.insertedOutboxIds, ...p2.insertedOutboxIds]);
  });

  it('deleteOutboxByIds chunks and is transactional', async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new SqliteAdapter(ds as any);
    (SqliteAdapter as any).DELETE_ID_CHUNK = 3;

    const ids = Array.from({ length: 7 }, (_, i) => String(1000 + i));
    await adapter.deleteOutboxByIds(ids);

    expect(qr.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');

    const del = (manager.query as jest.Mock).mock.calls.filter(([sql]: any[]) =>
      String(sql).startsWith(`DELETE FROM "outbox" WHERE id IN (`)
    );
    expect(del.length).toBe(3);
    const sent = del.flatMap(([, params]) => params as string[]);
    expect(sent.sort()).toEqual(ids.sort());
  });

  it('fetchDeliverAckChunk failure keeps rows; success deletes and advances watermark', async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new SqliteAdapter(ds as any);
    (adapter as any).lastSeenId = 0n;

    (ds.query as jest.Mock).mockResolvedValueOnce([
      {
        id: '1001',
        aggregateId: 'agg1',
        eventType: 'Ev',
        eventVersion: 1,
        requestId: 'r1',
        blockHeight: 1,
        payload: Buffer.from(JSON.stringify({ p: 1 }), 'utf8'),
        isCompressed: 0,
        timestamp: 1,
        ulen: 100,
      },
      {
        id: '1002',
        aggregateId: 'agg1',
        eventType: 'Ev',
        eventVersion: 2,
        requestId: 'r2',
        blockHeight: 2,
        payload: Buffer.from(JSON.stringify({ p: 2 }), 'utf8'),
        isCompressed: 0,
        timestamp: 2,
        ulen: 100,
      },
    ]);

    await expect(
      adapter.fetchDeliverAckChunk(10_000, async () => { throw new Error('fail'); })
    ).rejects.toThrow(/fail/);
    expect((adapter as any).lastSeenId).toBe(0n);

    (ds.query as jest.Mock).mockResolvedValueOnce([
      {
        id: '1001',
        aggregateId: 'agg1',
        eventType: 'Ev',
        eventVersion: 1,
        requestId: 'r1',
        blockHeight: 1,
        payload: Buffer.from(JSON.stringify({ p: 1 }), 'utf8'),
        isCompressed: 0,
        timestamp: 1,
        ulen: 100,
      },
    ]);

    const sent = await adapter.fetchDeliverAckChunk(10_000, async () => Promise.resolve());
    expect(sent).toBe(1);
    const del = (manager.query as jest.Mock).mock.calls.filter(([sql]: any[]) =>
      String(sql).startsWith(`DELETE FROM "outbox" WHERE id IN (`)
    );
    expect(del.length).toBe(1);
    expect(qr.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');
    expect((adapter as any).lastSeenId).toBe(1001n);
  });

  it('fetchDeliverAckChunk drains with budget chunking and no duplicates', async () => {
    const { ds, manager } = mkDS();
    const adapter = new SqliteAdapter(ds as any);
    (adapter as any).lastSeenId = 0n;

    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: String(1000 + i),
      aggregateId: 'agg1',
      eventType: 'Ev',
      eventVersion: i + 1,
      requestId: 'r' + (i + 1),
      blockHeight: i + 1,
      payload: Buffer.from(JSON.stringify({ p: i + 1 }), 'utf8'),
      isCompressed: 0,
      timestamp: 1000000 + i,
      ulen: 400,
    }));

    (ds.query as jest.Mock).mockImplementation(async (sql: any, params: any[]) => {
      const s = String(sql);
      if (s.includes(`FROM "outbox"`) && s.includes(`ORDER BY id ASC`)) {
        const last = BigInt(params?.[0] ?? 0);
        return rows.filter(r => BigInt(r.id) > last);
      }
      return [];
    });

    let sent = 0;
    while (true) {
      const n = await adapter.fetchDeliverAckChunk(2_000, async (evs) => {
        sent += evs.length;
      });
      if (n === 0) break;
    }
    expect(sent).toBe(10);

    const deletedIds = (manager.query as jest.Mock).mock.calls
      .filter(([sql]: any[]) => String(sql).startsWith(`DELETE FROM "outbox" WHERE id IN (`))
      .flatMap(([, params]) => params as string[]);
    expect(new Set(deletedIds).size).toBe(10);
  });

  it('hasBacklogBefore and hasAnyPendingAfterWatermark reflect state', async () => {
    const { ds } = mkDS();
    const adapter = new SqliteAdapter(ds as any);

    (ds.query as jest.Mock)
      .mockResolvedValueOnce([])                // hasAnyPendingAfterWatermark false
      .mockResolvedValueOnce([{ '1': 1 }])     // hasBacklogBefore true
      .mockResolvedValueOnce([])                // hasBacklogBefore false
      .mockResolvedValueOnce([{ '1': 1 }]);    // hasAnyPendingAfterWatermark true

    expect(await adapter.hasAnyPendingAfterWatermark()).toBe(false);
    expect(await adapter.hasBacklogBefore(0, '123')).toBe(true);
    expect(await adapter.hasBacklogBefore(0, '123')).toBe(false);
    (adapter as any).lastSeenId = 10n;
    expect(await adapter.hasAnyPendingAfterWatermark()).toBe(true);
  });

  it('createSnapshot/findLatest/createSnapshotAtHeight/applyEventsToAggregate/rehydrateAtHeight', async () => {
    const { ds } = mkDS();
    const adapter = new SqliteAdapter(ds as any);

    const rowSnap = {
      aggregateId: 'agg1',
      blockHeight: 9,
      version: 4,
      payload: Buffer.from(JSON.stringify({ s: 1 })),
      isCompressed: 0,
    };
    const rowsApply = [
      { type: 'Ev', requestId: 'r1', blockHeight: 1, payload: Buffer.from(JSON.stringify({ x: 1 })), isCompressed: 0, version: 1, timestamp: 11 },
      { type: 'Ev', requestId: 'r2', blockHeight: 2, payload: Buffer.from(JSON.stringify({ x: 2 })), isCompressed: 0, version: 2, timestamp: 12 },
    ];
    const rowsRange = [
      { type: 'Ev', requestId: 'r4', blockHeight: 6, payload: Buffer.from(JSON.stringify({ x: 4 })), isCompressed: 0, version: 4, timestamp: 21 },
    ];

    (ds.query as jest.Mock).mockImplementation(async (sql: any, params: any[]) => {
      const s = String(sql);
      if (/INSERT OR IGNORE INTO "snapshots"\s*\("aggregateId","blockHeight","version","payload","isCompressed"\)\s*VALUES/s.test(s)) {
        return undefined;
      }
      if (/SELECT "blockHeight"\s+FROM "snapshots"\s+WHERE "aggregateId" = \?\s+ORDER BY "blockHeight" DESC\s+LIMIT 1/s.test(s)) {
        return [{ blockHeight: 12 }];
      }
      if (/SELECT "aggregateId","blockHeight","version","payload","isCompressed"\s+FROM "snapshots"\s+WHERE "aggregateId" = \? AND "blockHeight" <= \?\s+ORDER BY "blockHeight" DESC\s+LIMIT 1/s.test(s)) {
        return [rowSnap];
      }
      if (/FROM "agg1"\s+WHERE "version" > \?\s+ORDER BY "version" ASC/s.test(s)) {
        return rowsApply;
      }
      if (/FROM "agg1"[\s\S]*"blockHeight" IS NOT NULL[\s\S]*AND "version" > \?[\s\S]*AND "blockHeight" <= \?[\s\S]*ORDER BY "version" ASC/s.test(s)) {
        return rowsRange;
      }
      return [];
    });

    await adapter.createSnapshot(new TestAgg('agg1', 10, 5) as any, { minKeep: 2, keepWindow: 0 });

    expect(ds.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT OR IGNORE INTO "snapshots"\s*\("aggregateId","blockHeight","version","payload","isCompressed"\)\s*VALUES/s),
      ['agg1', 10, 5, expect.any(Buffer), 0]
    );

    const last = await adapter.findLatestSnapshot('agg1');
    expect(last).toEqual({ blockHeight: 12 });

    const snapAt = await adapter.createSnapshotAtHeight(new TestAgg('agg1', 10, 5) as any, 10);
    expect(snapAt.aggregateId).toBe('agg1');
    expect(snapAt.blockHeight).toBe(9);
    expect(snapAt.version).toBe(4);
    expect(snapAt.payload).toEqual({ s: 1 });

    const a1 = new TestAgg('agg1', 0, 0);
    const spy1 = jest.spyOn(a1, 'loadFromHistory');
    await adapter.applyEventsToAggregate(a1 as any, 0);
    expect(spy1).toHaveBeenCalled();
    const hist = spy1.mock.calls[0]![0];
    expect(Array.isArray(hist)).toBe(true);
    expect(hist.length).toBe(2);

    const a2 = new TestAgg('agg1', 0, 0);
    const spyFrom = jest.spyOn(a2, 'fromSnapshot');
    const spyLoad = jest.spyOn(a2, 'loadFromHistory');
    await adapter.rehydrateAtHeight(a2 as any, 6);
    expect(spyFrom).toHaveBeenCalled();
    expect(spyLoad).toHaveBeenCalled();
    const range = spyLoad.mock.calls[0]![0];
    expect(range.length).toBe(1);
  });

  it('deleteSnapshotsByBlockHeight/pruneOldSnapshots/pruneEvents are transactional', async () => {
    const { ds, qr, manager } = mkDS();
    const adapter = new SqliteAdapter(ds as any);

    await adapter.deleteSnapshotsByBlockHeight(['a1', 'a2'], 10);
    expect(qr.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');
    const del1 = (manager.query as jest.Mock).mock.calls.filter(([sql]: any[]) =>
      String(sql).includes(`DELETE FROM "snapshots"`) && String(sql).includes(`"aggregateId" = ? AND "blockHeight" = ?`)
    );
    expect(del1.length).toBe(2);

    (ds.query as jest.Mock).mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: i + 1, blockHeight: 1 + i }))
    );
    await adapter.pruneOldSnapshots('a1', 10, { minKeep: 2, keepWindow: 3 });
    const del2 = (manager.query as jest.Mock).mock.calls.filter(([sql]: any[]) =>
      String(sql).startsWith(`DELETE FROM "snapshots" WHERE "id" IN (`)
    );
    expect(del2.length).toBeGreaterThan(0);

    await adapter.pruneEvents('agg1', 7);
    expect(ds.query).toHaveBeenCalledWith(
      `DELETE FROM "agg1" WHERE "blockHeight" IS NOT NULL AND "blockHeight" <= ?`,
      [7]
    );
  });
});
