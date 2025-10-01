import 'reflect-metadata';
import { BrowserSqljsAdapter } from '../browser-sqljs.adapter';

function mkEvent(aggregateId: string, requestId: string, version: number, payload: any, timestamp: number, blockHeight?: number) {
  const proto: any = {};
  Object.defineProperty(proto, 'constructor', { value: { name: 'Ev' }, enumerable: false });
  return Object.assign(Object.create(proto), {
    aggregateId,
    requestId,
    blockHeight,
    timestamp,
    payload,
    version,
  });
}

class TestAgg {
  public version: number;
  public lastBlockHeight: number | null;
  private unsaved: any[] = [];
  public aggregateId: string;
  public allowPruning?: boolean;
  constructor(id: string, version: number, height: number | null) {
    this.aggregateId = id;
    this.version = version;
    this.lastBlockHeight = height;
  }
  addUnsaved(ev: any) { this.unsaved.push(ev); }
  getUnsavedEvents() { return this.unsaved; }
  clearUnsavedEvents() { this.unsaved = []; }
  canMakeSnapshot() { return true; }
  getSnapshotRetention() { return { minKeep: 2, keepWindow: 10 }; }
  resetSnapshotCounter() {}
  loadFromHistory(_: any[]) {}
  markEventsAsSaved() { this.unsaved = []; }
  toSnapshot() { return { ok: true, version: this.version, blockHeight: this.lastBlockHeight ?? -1 }; }
  fromSnapshot(_: any) {}
}

function mkDS() {
  const qr = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    manager: { query: jest.fn().mockResolvedValue(undefined) },
    release: jest.fn().mockResolvedValue(undefined),
  };
  const ds = {
    createQueryRunner: jest.fn(() => qr),
    query: jest.fn().mockResolvedValue(undefined),
  };
  return { ds, qr };
}

function callsOf(fn: jest.Mock) {
  return (fn.mock.calls || []) as any[][];
}

describe('BrowserSqljsAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persistAggregatesAndOutbox writes aggregate rows and outbox, then commits', async () => {
    const { ds, qr } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    (adapter as any).idGen = { next: jest.fn((ts: number) => BigInt(ts)) };

    const a = new TestAgg('agg1', 2, 2);
    const t1 = 1000001; const t2 = 1000005;
    a.addUnsaved(mkEvent('agg1', 'r1', 1, { x: 1 }, t1, 1));
    a.addUnsaved(mkEvent('agg1', 'r2', 2, { x: 2 }, t2, 2));

    const res = await adapter.persistAggregatesAndOutbox([a as any]);

    const mCalls = callsOf(qr.manager.query as any);
    expect(qr.query).toHaveBeenCalledWith('BEGIN');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');
    expect(mCalls.some(([sql]) => String(sql).includes(`INSERT OR IGNORE INTO "agg1"`))).toBe(true);
    expect(mCalls.some(([sql]) => String(sql).includes(`INSERT OR IGNORE INTO "outbox"`))).toBe(true);
    expect(res.insertedOutboxIds.length).toBe(2);
    expect(res.rawEvents.length).toBe(2);
  });

  it('deleteOutboxByIds chunks via IN lists inside tx', async () => {
    const { ds, qr } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    const ids = Array.from({ length: 20001 }, (_, i) => String(i + 1));
    await adapter.deleteOutboxByIds(ids);
    const mCalls = callsOf(qr.manager.query as any);
    expect(mCalls.length).toBeGreaterThan(1);
    expect(String(mCalls[0]![0])).toContain(`DELETE FROM "outbox" WHERE "id" IN (`);
    expect(qr.query).toHaveBeenCalledWith('BEGIN');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');
  });

  it('hasBacklogBefore checks by id', async () => {
    const { ds } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    (ds.query as jest.Mock).mockResolvedValueOnce([{}]);
    const ok = await adapter.hasBacklogBefore(1000, '10');
    expect(ok).toBe(true);
  });

  it('hasAnyPendingAfterWatermark checks new rows', async () => {
    const { ds } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    (adapter as any).lastSeenId = 50n;
    (ds.query as jest.Mock).mockResolvedValueOnce([{}]);
    const ok = await adapter.hasAnyPendingAfterWatermark();
    expect(ok).toBe(true);
  });

  it('fetchDeliverAckChunk selects from ds.query, delivers, then deletes acked ids', async () => {
    const { ds, qr } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    (ds.query as jest.Mock).mockResolvedValueOnce([
      { id: '1', aggregateId: 'A', eventType: 'Ev', eventVersion: 1, requestId: 'r1', blockHeight: 1, payload: Buffer.from('{"a":1}'), isCompressed: 0, timestamp: 11, ulen: 12 },
      { id: '2', aggregateId: 'A', eventType: 'Ev', eventVersion: 1, requestId: 'r2', blockHeight: 2, payload: Buffer.from('{"b":2}'), isCompressed: 0, timestamp: 12, ulen: 12 },
    ]);
    const pub = jest.fn().mockResolvedValue(undefined);
    const n = await adapter.fetchDeliverAckChunk(1024 * 1024, pub);
    expect(n).toBe(2);
    expect(pub).toHaveBeenCalledTimes(1);
    const mCalls = callsOf(qr.manager.query as any);
    expect(mCalls.some(([sql]) => String(sql).includes(`DELETE FROM "outbox"`))).toBe(true);
    expect(qr.query).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(qr.query).toHaveBeenCalledWith('COMMIT');
  });

  it('fetchEventsForOneAggregateRead applies filters and pagination', async () => {
    const { ds } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    (ds.query as jest.Mock).mockResolvedValueOnce([
      { type: 'Ev', payload: Buffer.from('{"a":1}'), version: 1, requestId: 'r', blockHeight: 1, timestamp: 10, isCompressed: 0 },
    ]);
    const out = await adapter.fetchEventsForOneAggregateRead('agg1', { versionGte: 1, limit: 10, offset: 0 });
    expect(out.length).toBe(1);
    expect(out[0]!.modelId).toBe('agg1');
  });

  it('fetchEventsForManyAggregatesRead loops ids and concatenates', async () => {
    const { ds } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    (ds.query as jest.Mock)
      .mockResolvedValueOnce([
        { type: 'Ev', payload: Buffer.from('{"a":1}'), version: 1, requestId: 'r', blockHeight: 1, timestamp: 10, isCompressed: 0 },
      ])
      .mockResolvedValueOnce([
        { type: 'Ev', payload: Buffer.from('{"b":2}'), version: 1, requestId: 'r', blockHeight: 2, timestamp: 11, isCompressed: 0 },
      ]);
    const out = await adapter.fetchEventsForManyAggregatesRead(['a1', 'a2'], { limit: 100 });
    expect(out.length).toBe(2);
    expect(out[0]!.modelId).toBe('a1');
    expect(out[1]!.modelId).toBe('a2');
  });

  it('getOneModelByHeightRead restores and returns snapshot row', async () => {
    const { ds } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    const model: any = new TestAgg('m1', 3, 10);
    const spy = jest.spyOn(adapter as any, 'restoreExactStateAtHeight').mockResolvedValue(undefined);
    const row = await adapter.getOneModelByHeightRead(model, 5);
    expect(spy).toHaveBeenCalledWith(model, 5);
    expect(row?.modelId).toBe('m1');
  });

  it('getManyModelsByHeightRead returns multiple rows', async () => {
    const { ds } = mkDS();
    const adapter = new BrowserSqljsAdapter(ds as any);
    jest.spyOn(adapter, 'getOneModelByHeightRead').mockResolvedValue({ aggregateId: 'm', blockHeight: 5, version: 1, payload: '{}' } as any);
    const rows = await adapter.getManyModelsByHeightRead([{ aggregateId: 'a' } as any, { aggregateId: 'b' } as any], 5);
    expect(rows.length).toBe(2);
  });
});
