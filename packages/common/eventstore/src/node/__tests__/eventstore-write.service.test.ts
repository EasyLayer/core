import 'reflect-metadata';
import { EventStoreWriteService } from '../eventstore-write.service';
import type { PublisherProvider } from '@easylayer/common/cqrs-transport';

jest.mock('@easylayer/common/exponential-interval-async', () => {
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
}

function mkEvent(requestId = 'r', blockHeight = 1) {
  return { modelName:'m', eventType:'E', eventVersion:1, requestId, blockHeight, payload:'{}', timestamp:1 };
}

function mkPersist(rawEvents: any[] = []) {
  return {
    insertedOutboxIds: ['1','2'],
    firstTs: 100,
    firstId: '1',
    lastTs: 200,
    lastId: '2',
    rawEvents,
  };
}

describe('EventStoreWriteService', () => {
  let pub: PublisherProvider & { publisher: { hasRemoteTransport: jest.Mock; publishWireStreamBatchWithAck: jest.Mock; publishSystemEventsLocally: jest.Mock } };
  let adapter: any;
  let readSvc: any;

  beforeEach(() => {
    pub = {
      publisher: {
        hasRemoteTransport: jest.fn().mockReturnValue(true),
        publishWireStreamBatchWithAck: jest.fn().mockImplementation(async (events: any[]) => ({ ok: true, okIndices: events.map((_, i) => i) })),
        publishSystemEventsLocally: jest.fn(),
      },
    } as any;

    adapter = {
      persistAggregatesAndOutbox: jest.fn(),
      hasBacklogBefore: jest.fn(),
      hasPendingAfterId: jest.fn(),
      deleteOutboxByIds: jest.fn().mockResolvedValue(undefined),
      fetchDeliverAckChunk: jest.fn().mockResolvedValue(0),
      createSnapshot: jest.fn(),
      rollbackAggregates: jest.fn(),
      advanceWatermark: jest.fn(),
    };

    readSvc = {
      cache: {
        set: jest.fn(),
        del: jest.fn(),
      },
    };
  });

  it('save drains persisted outbox rows instead of publishing raw events from memory', async () => {
    const a = new TestAgg('a1', 10, 1, true);
    const localRawEvent = mkEvent('local-raw', 10);
    const outboxRowEvent = mkEvent('outbox-row', 10);

    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([localRawEvent]));
    adapter.fetchDeliverAckChunk
      .mockImplementationOnce(async (_cap: number, cb: (evs:any[])=>Promise<any>) => {
        await cb([outboxRowEvent]);
        return 1;
      })
      .mockResolvedValueOnce(0);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.save(a as any);

    expect(readSvc.cache.set).toHaveBeenCalledWith('a1', a);
    expect(adapter.persistAggregatesAndOutbox).toHaveBeenCalledWith([a], { writeOutbox: true });
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalledTimes(2);
    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledWith([outboxRowEvent]);
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalledWith([localRawEvent]);
    expect(adapter.deleteOutboxByIds).not.toHaveBeenCalled();
    expect(adapter.hasBacklogBefore).not.toHaveBeenCalled();
    expect(adapter.hasPendingAfterId).not.toHaveBeenCalled();
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith([localRawEvent]);

    const [remotePublishCallOrder] = pub.publisher.publishWireStreamBatchWithAck.mock.invocationCallOrder;
    const [localEmitCallOrder] = pub.publisher.publishSystemEventsLocally.mock.invocationCallOrder;
    if (remotePublishCallOrder === undefined || localEmitCallOrder === undefined) {
      throw new Error('Expected local and remote publisher calls to be recorded');
    }
    expect(remotePublishCallOrder).toBeLessThan(localEmitCallOrder);
    expect(adapter.createSnapshot).toHaveBeenCalledWith(a, { minKeep: 2, keepWindow: 0, allowPruning: false }, undefined);
    expect(a.resetSnapshotCounter).toHaveBeenCalled();
  });

  it('save runs in local-only mode without writing or draining outbox when no remote transport is configured', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    const rawEvents = [mkEvent('local-only', 1)];
    pub.publisher.hasRemoteTransport.mockReturnValue(false);
    adapter.persistAggregatesAndOutbox.mockResolvedValue({
      ...mkPersist(rawEvents),
      insertedOutboxIds: [],
      firstId: '0',
      lastId: '0',
    });

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.onModuleInit();
    await svc.save(a as any);

    expect(adapter.persistAggregatesAndOutbox).toHaveBeenCalledWith([a], { writeOutbox: false });
    expect(adapter.fetchDeliverAckChunk).not.toHaveBeenCalled();
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalled();
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith(rawEvents);
  });

  it('save emits local system events even when outbox drain fails and leaves rows for retry', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    const rawEvents = [mkEvent('raw-after-fail', 1)];
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist(rawEvents));
    adapter.fetchDeliverAckChunk.mockRejectedValueOnce(new Error('transport unavailable'));

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.save(a as any);

    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalled();
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith(rawEvents);
    expect((svc as any).drainFailing).toBe(true);
  });

  it('serializes concurrent saves through the outbox table drain and never redelivers raw memory events', async () => {
    const a1 = new TestAgg('a1', 10, 1, false);
    const a2 = new TestAgg('a2', 11, 1, false);
    const rawA = mkEvent('raw-a', 10);
    const rawB = mkEvent('raw-b', 11);
    const rowA = mkEvent('row-a', 10);
    const rowB = mkEvent('row-b', 11);

    adapter.persistAggregatesAndOutbox
      .mockResolvedValueOnce(mkPersist([rawA]))
      .mockResolvedValueOnce({
        ...mkPersist([rawB]),
        insertedOutboxIds: ['3'],
        firstTs: 300,
        firstId: '3',
        lastTs: 300,
        lastId: '3',
      });

    let resolveFirstAck!: (value: any) => void;
    const firstAck = new Promise((resolve) => { resolveFirstAck = resolve; });

    adapter.fetchDeliverAckChunk
      .mockImplementationOnce(async (_cap: number, cb: (evs:any[])=>Promise<any>) => {
        await cb([rowA, rowB]);
        return 2;
      })
      .mockImplementationOnce(async () => 0)
      .mockImplementation(async () => 0);

    pub.publisher.publishWireStreamBatchWithAck.mockImplementationOnce(() => firstAck);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});

    const save1 = svc.save(a1 as any);
    while (pub.publisher.publishWireStreamBatchWithAck.mock.calls.length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const save2 = svc.save(a2 as any);
    await new Promise((resolve) => setImmediate(resolve));

    // The second save may persist, but it must not start a second drain while
    // the first drain is still waiting for ACK.
    expect(adapter.persistAggregatesAndOutbox).toHaveBeenCalledTimes(2);
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledWith([rowA, rowB]);
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalledWith([rawA]);
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalledWith([rawB]);

    resolveFirstAck({ ok: true, okIndices: [0, 1] });
    await Promise.all([save1, save2]);

    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalledTimes(3);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith([rawA]);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith([rawB]);
  });

  it('serializes explicit retry drain behind an in-flight save drain', async () => {
    const a1 = new TestAgg('a1', 10, 1, false);
    const rawA = mkEvent('raw-a', 10);
    const rowA = mkEvent('row-a', 10);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([rawA]));

    let resolveFirstAck!: (value: any) => void;
    const firstAck = new Promise((resolve) => { resolveFirstAck = resolve; });
    adapter.fetchDeliverAckChunk
      .mockImplementationOnce(async (_cap: number, cb: (evs:any[])=>Promise<any>) => {
        await cb([rowA]);
        return 1;
      })
      .mockResolvedValue(0);
    pub.publisher.publishWireStreamBatchWithAck.mockImplementationOnce(() => firstAck);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});

    const save1 = svc.save(a1 as any);
    while (pub.publisher.publishWireStreamBatchWithAck.mock.calls.length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const drain = (svc as any).runDrainOnce('test-drain');
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalledTimes(1);

    resolveFirstAck({ ok: true, okIndices: [0] });
    await Promise.all([save1, drain]);

    expect(adapter.fetchDeliverAckChunk.mock.invocationCallOrder[0]).toBeLessThan(adapter.fetchDeliverAckChunk.mock.invocationCallOrder[1]);
  });

  it('rollback clears cache, rolls back, and saves modelsToSave through outbox drain', async () => {
    const m1 = new TestAgg('a1', 10, 1);
    const m2 = new TestAgg('a2', 20, 2);
    const ms = new TestAgg('b1', 1, 1);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.fetchDeliverAckChunk.mockResolvedValue(0);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.rollback({ modelsToRollback: [m1 as any, m2 as any], blockHeight: 5, modelsToSave: [ms as any] });

    expect(readSvc.cache.del).toHaveBeenCalledWith('a1');
    expect(readSvc.cache.del).toHaveBeenCalledWith('a2');
    expect(adapter.rollbackAggregates).toHaveBeenCalledWith(['a1','a2'], 5);
    expect(adapter.persistAggregatesAndOutbox).toHaveBeenCalledWith([ms], { writeOutbox: true });
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalled();
  });

  it('drainFailing flag is cleared after retry drain succeeds', async () => {
    adapter.fetchDeliverAckChunk.mockResolvedValue(0);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});

    (svc as any).startRetryTimerIfNeeded();
    expect((svc as any).drainFailing).toBe(true);

    const timer = (svc as any).retryTimer;
    await timer.trigger();

    expect((svc as any).drainFailing).toBe(false);
  });
});
