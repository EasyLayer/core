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
      fetchDeliverAckChunk: jest.fn(),
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

  it('save publishes raw events, deletes outbox ids, creates snapshot and resets counter', async () => {
    const a = new TestAgg('a1', 10, 1, true);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(
      mkPersist([{ modelName:'m',eventType:'E',eventVersion:1,requestId:'r',blockHeight:1,payload:'{}',timestamp:1 }])
    );
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasPendingAfterId.mockResolvedValue(false);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.save(a as any);

    expect(readSvc.cache.set).toHaveBeenCalledWith('a1', a);
    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ modelName: 'm', eventType: 'E' })]));
    const [remotePublishCallOrder] = pub.publisher.publishWireStreamBatchWithAck.mock.invocationCallOrder;
    const [localEmitCallOrder] = pub.publisher.publishSystemEventsLocally.mock.invocationCallOrder;
    if (remotePublishCallOrder === undefined || localEmitCallOrder === undefined) {
      throw new Error('Expected local and remote publisher calls to be recorded');
    }
    expect(remotePublishCallOrder).toBeLessThan(localEmitCallOrder);
    expect(adapter.deleteOutboxByIds).toHaveBeenCalledWith(['1','2']);
    expect(adapter.createSnapshot).toHaveBeenCalledWith(a, { minKeep: 2, keepWindow: 0 });
    expect(a.resetSnapshotCounter).toHaveBeenCalled();
  });

  it('save runs in local-only mode without writing or draining outbox when no remote transport is configured', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    const rawEvents = [{ modelName:'m',eventType:'E',eventVersion:1,requestId:'r',blockHeight:1,payload:'{}',timestamp:1 }];
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
    expect(adapter.hasBacklogBefore).not.toHaveBeenCalled();
    expect(adapter.hasPendingAfterId).not.toHaveBeenCalled();
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalled();
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith(rawEvents);
  });

  it('save uses strict drain when backlog exists', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.hasBacklogBefore.mockResolvedValue(true);
    adapter.fetchDeliverAckChunk
      .mockImplementationOnce(async (_cap: number, cb: (evs:any[])=>Promise<any>) => {
        await cb([{ modelName:'m',eventType:'E',eventVersion:1,requestId:'r',blockHeight:1,payload:'{}',timestamp:1 }]);
        return 1;
      })
      .mockResolvedValueOnce(0);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.save(a as any);

    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith([]);
    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(adapter.deleteOutboxByIds).not.toHaveBeenCalled();
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalledTimes(2);
  });

  it('save uses strict drain when pending after watermark', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasPendingAfterId.mockResolvedValue(true);
    adapter.fetchDeliverAckChunk.mockResolvedValueOnce(0);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.save(a as any);

    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith([]);
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalled();
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalled();
  });

  it('save emits local system events even when remote transport publish fails', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    const rawEvents = [{ modelName:'m',eventType:'E',eventVersion:1,requestId:'r',blockHeight:1,payload:'{}',timestamp:1 }];
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist(rawEvents));
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasPendingAfterId.mockResolvedValue(false);
    pub.publisher.publishWireStreamBatchWithAck.mockRejectedValueOnce(new Error('transport unavailable'));

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.save(a as any);

    expect(pub.publisher.publishWireStreamBatchWithAck).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledTimes(1);
    expect(pub.publisher.publishSystemEventsLocally).toHaveBeenCalledWith(rawEvents);
    const [remotePublishCallOrder] = pub.publisher.publishWireStreamBatchWithAck.mock.invocationCallOrder;
    const [localEmitCallOrder] = pub.publisher.publishSystemEventsLocally.mock.invocationCallOrder;
    if (remotePublishCallOrder === undefined || localEmitCallOrder === undefined) {
      throw new Error('Expected local and remote publisher calls to be recorded');
    }
    expect(remotePublishCallOrder).toBeLessThan(localEmitCallOrder);
    expect(adapter.deleteOutboxByIds).not.toHaveBeenCalled();
    expect((svc as any).drainFailing).toBe(true);
  });

  it('rollback clears cache, rolls back, and saves modelsToSave', async () => {
    const m1 = new TestAgg('a1', 10, 1);
    const m2 = new TestAgg('a2', 20, 2);
    const ms = new TestAgg('b1', 1, 1);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(mkPersist([]));
    adapter.hasBacklogBefore.mockResolvedValue(false);
    adapter.hasPendingAfterId.mockResolvedValue(false);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});
    await svc.rollback({ modelsToRollback: [m1 as any, m2 as any], blockHeight: 5, modelsToSave: [ms as any] });

    expect(readSvc.cache.del).toHaveBeenCalledWith('a1');
    expect(readSvc.cache.del).toHaveBeenCalledWith('a2');
    expect(adapter.rollbackAggregates).toHaveBeenCalledWith(['a1','a2'], 5);
    expect(adapter.persistAggregatesAndOutbox).toHaveBeenCalledWith([ms], { writeOutbox: true });
  });

  // B5: fast-path is skipped while drain is in retry state
  it('save skips fast-path publish when drain is in retry state', async () => {
    const a = new TestAgg('a1', 10, 1, false);
    adapter.persistAggregatesAndOutbox.mockResolvedValue(
      mkPersist([{ modelName:'m',eventType:'E',eventVersion:1,requestId:'r',blockHeight:1,payload:'{}',timestamp:1 }])
    );
    adapter.hasBacklogBefore.mockResolvedValue(false);
    // Drain will fail on startup, then succeed on retry
    adapter.fetchDeliverAckChunk
      .mockRejectedValueOnce(new Error('transport unavailable')) // startup drain fails
      .mockResolvedValue(0); // retry and subsequent drains succeed

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});

    // onModuleInit triggers startup drain which fails → drainFailing = true
    // (onModuleInit is called by NestJS; call it manually here)
    await (svc as any).runDrainOnce().catch(() => {});

    // Manually trigger startRetryTimerIfNeeded to set drainFailing = true
    (svc as any).startRetryTimerIfNeeded();
    expect((svc as any).drainFailing).toBe(true);

    // Now save() should skip fast-path and call runDrainOnce instead
    adapter.hasPendingAfterId.mockResolvedValue(false);
    await svc.save(a as any);

    // publishWireStreamBatchWithAck must NOT have been called directly (fast-path skipped)
    expect(pub.publisher.publishWireStreamBatchWithAck).not.toHaveBeenCalled();
    // fetchDeliverAckChunk was called as part of drain
    expect(adapter.fetchDeliverAckChunk).toHaveBeenCalled();
  });

  // B5: drainFailing is cleared after successful drain
  it('drainFailing flag is cleared after drain succeeds', async () => {
    adapter.fetchDeliverAckChunk.mockResolvedValue(0);

    const svc = new EventStoreWriteService<any>(adapter as any, pub as any, readSvc as any, {});

    // Set drainFailing and get the retry timer mock
    (svc as any).startRetryTimerIfNeeded();
    expect((svc as any).drainFailing).toBe(true);

    // Trigger retry — drain succeeds → drainFailing should be cleared
    const timer = (svc as any).retryTimer;
    await timer.trigger();

    expect((svc as any).drainFailing).toBe(false);
  });
});
