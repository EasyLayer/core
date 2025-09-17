import "reflect-metadata";
import { EventStoreService } from "../core/eventstore.service";
import { Publisher } from "@easylayer/common/cqrs-transport";

jest.mock("@easylayer/common/exponential-interval-async", () => {
  return {
    exponentialIntervalAsync: (fn: (reset: () => void) => Promise<void>, _opt: any) => {
      let destroyed = false;
      const api = {
        trigger: async () => {
          if (destroyed) return;
          let didReset = false;
          await fn(() => { didReset = true; });
          (api as any)._didReset = didReset;
        },
        destroy: () => { destroyed = true; (api as any)._destroyed = true; },
        _destroyed: false,
        _didReset: false,
      };
      return api as any;
    },
  };
});

class TestAgg {
  constructor(
    public aggregateId: string,
    public lastBlockHeight: number,
    public version: number,
    public canSnap = false,
  ) {}
  canMakeSnapshot() { return this.canSnap; }
  getSnapshotRetention() { return { minKeep: 2, keepWindow: 0 }; }
  resetSnapshotCounter = jest.fn();
  fromSnapshot = jest.fn();
}

function mkPersist(rawEvents: any[] = []) {
  return {
    insertedOutboxIds: ["1","2"],
    firstTs: 100,
    firstId: "1",
    lastTs: 200,
    lastId: "2",
    rawEvents,
  };
}

describe("EventStoreService", () => {
  let log: any;
  let pub: Publisher & { publishWireStreamBatchWithAck: jest.Mock };
  let adapter: any;

  beforeEach(() => {
    log = { debug: jest.fn(), warn: jest.fn() };
    pub = { publishWireStreamBatchWithAck: jest.fn().mockResolvedValue(undefined) } as any;

    adapter = {
      persistAggregatesAndOutbox: jest.fn(),
      hasBacklogBefore: jest.fn(),
      hasAnyPendingAfterWatermark: jest.fn(),
      deleteOutboxByIds: jest.fn().mockResolvedValue(undefined),
      fetchDeliverAckChunk: jest.fn(),
      findLatestSnapshot: jest.fn(),
      createSnapshotAtHeight: jest.fn(),
      applyEventsToAggregate: jest.fn(),
      fetchEventsForAggregates: jest.fn(),
      createSnapshot: jest.fn(),
      rollbackAggregates: jest.fn(),
      rehydrateAtHeight: jest.fn(),
      getDriverType: jest.fn(()=>'postgres'),
    };
  });

  it("onModuleInit drains once", async () => {
    adapter.fetchDeliverAckChunk.mockResolvedValueOnce(0);
    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.onModuleInit();
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalled();
  });

  it("save fast-path publishes raw events, deletes outbox ids, snapshots and resets counter", async () => {
    const a = new TestAgg("a1", 10, 1, true);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(
      mkPersist([{ modelName:"m",eventType:"E",eventVersion:1,requestId:"r",blockHeight:1,payload:"{}",timestamp:1 }])
    );
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasAnyPendingAfterWatermark.mockResolvedValue(false);

    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.save(a as any);

    expect(pub.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(adapter.deleteOutboxByIds).toHaveBeenCalledWith(["1","2"]);
    expect(adapter.createSnapshot).toHaveBeenCalledWith(a, { minKeep: 2, keepWindow: 0 });
    expect(a.resetSnapshotCounter).toHaveBeenCalled();
  });

  it("save strict-drain when backlog exists", async () => {
    const a = new TestAgg("a1", 10, 1, false);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.hasBacklogBefore.mockResolvedValue(true);
    adapter.fetchDeliverAckChunk
      .mockImplementationOnce(async (_cap: number, cb: (evs:any[])=>Promise<void>) => {
        await cb([{ modelName:"m",eventType:"E",eventVersion:1,requestId:"r",blockHeight:1,payload:"{}",timestamp:1 }]);
        return 1;
      })
      .mockResolvedValueOnce(0);

    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.save(a as any);

    expect(pub.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(adapter.deleteOutboxByIds).not.toHaveBeenCalled();
  });

  it("save strict-drain when pending after watermark", async () => {
    const a = new TestAgg("a1", 10, 1, false);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasAnyPendingAfterWatermark.mockResolvedValue(true);
    adapter.fetchDeliverAckChunk.mockResolvedValueOnce(0);

    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.save(a as any);

    expect(pub.publishWireStreamBatchWithAck).not.toHaveBeenCalled();
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalled();
  });

  it("rollback clears cache, rolls back and rehydrates, then saves modelsToSave", async () => {
    const m1 = new TestAgg("a1", 10, 1);
    const m2 = new TestAgg("a2", 20, 2);
    const ms = new TestAgg("b1", 1, 1);
    adapter.rehydrateAtHeight.mockResolvedValue(undefined);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasAnyPendingAfterWatermark.mockResolvedValue(false);

    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.save(m1 as any);

    await svc.rollback({ modelsToRollback: [m1 as any, m2 as any], blockHeight: 5, modelsToSave: [ms as any] });

    expect(adapter.rollbackAggregates).toHaveBeenCalledWith(["a1","a2"], 5);
    expect(adapter.rehydrateAtHeight).toHaveBeenCalledTimes(2);
  });

  it("getOne returns from cache on second call", async () => {
    const m = new TestAgg("a1", 0, 0);
    adapter.findLatestSnapshot.mockResolvedValue(null);
    adapter.applyEventsToAggregate.mockResolvedValue(undefined);

    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.getOne(m as any);
    await svc.getOne(m as any);
    expect(adapter.applyEventsToAggregate).toHaveBeenCalledTimes(1);
  });

  it("getOne hydrates from snapshot when available", async () => {
    const m = new TestAgg("a1", 0, 0);
    adapter.findLatestSnapshot.mockResolvedValue({ blockHeight: 7 });
    adapter.createSnapshotAtHeight.mockResolvedValue({ aggregateId:"a1", version:3, blockHeight:7, payload:{ s:1 } });
    adapter.applyEventsToAggregate.mockResolvedValue(undefined);

    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.getOne(m as any);

    expect(m.fromSnapshot).toHaveBeenCalledWith({ aggregateId:"a1", version:3, blockHeight:7, payload:{ s:1 } });
    expect(adapter.applyEventsToAggregate).toHaveBeenCalledWith(m, m.version);
  });

  it("getAtBlockHeight reconstructs at given height", async () => {
    const m = new TestAgg("a1", 0, 0);
    adapter.createSnapshotAtHeight.mockResolvedValue({ aggregateId:"a1", version:2, blockHeight:5, payload:{ x:1 } });
    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    await svc.getAtBlockHeight(m as any, 5);
    expect(m.fromSnapshot).toHaveBeenCalledWith({ aggregateId:"a1", version:2, blockHeight:5, payload:{ x:1 } });
  });

  it("fetchEventsForAggregates proxies to adapter", async () => {
    const evs = [{}, {}] as any;
    adapter.fetchEventsForAggregates.mockResolvedValue(evs);
    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    const out = await svc.fetchEventsForAggregates(["a"], { limit: 10 });
    expect(out).toBe(evs);
  });

  it("drain error schedules retry and stops after successful retry", async () => {
    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    adapter.fetchDeliverAckChunk
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(0);

    await expect((svc as any).drainOutboxCompletely()).rejects.toThrow(/boom/);

    const timer = (svc as any).retryTimer;
    expect(timer).toBeTruthy();

    await timer.trigger();
    expect((timer as any)._didReset).toBe(true);
    expect((timer as any)._destroyed).toBe(true);
    expect((svc as any).retryTimer).toBeNull();
  });

  it("onModuleDestroy destroys retry timer", () => {
    const svc = new EventStoreService<any>(log as any, adapter as any, pub as any, {});
    (svc as any).retryTimer = { destroy: jest.fn() };
    svc.onModuleDestroy();
    expect((svc as any).retryTimer).toBeNull();
  });
});
