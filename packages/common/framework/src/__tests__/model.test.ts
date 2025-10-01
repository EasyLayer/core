import { Model } from '../model';

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'fixed-request-id'),
}));

jest.mock('@easylayer/common/cqrs', () => {
  class BasicEvent {
    aggregateId: string;
    requestId: string;
    blockHeight: number;
    timestamp: number;
    payload: any;
    constructor(system: { aggregateId: string; requestId: string; blockHeight: number; timestamp?: number }, payload: any) {
      this.aggregateId = system.aggregateId;
      this.requestId = system.requestId;
      this.blockHeight = system.blockHeight;
      this.timestamp = system.timestamp ?? 1112223334445;
      this.payload = payload;
    }
  }
  class AggregateRoot {
    public recordedEvents: any[] = [];
    public _rehydrating = false;
    public aggregateId?: string;
    public lastBlockHeight?: number;
    constructor(aggregateId?: string, lastBlockHeight?: number) {
      this.aggregateId = aggregateId;
      this.lastBlockHeight = lastBlockHeight;
    }
    apply(event: any) {
      this.recordedEvents.push(event);
    }
    getUncommittedEvents() {
      return this.recordedEvents;
    }
    loadFromHistory(events: any[]) {
      for (const e of events) this.apply(e);
    }
  }
  return { BasicEvent, AggregateRoot, AggregateOptions: {} as any };
});

class TestModel extends Model {
  public exposedApplyEvent(eventName: string, blockHeight: number, payload?: any) {
    (this as any).applyEvent(eventName, blockHeight, payload);
  }
  public async processBlock(): Promise<void> {}
}

describe('Model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws on direct apply outside of rehydration', () => {
    const instance = new TestModel('aggregate-1', 100);
    expect(() => (instance as any).apply({ any: 'event' })).toThrow(
      'Direct apply(event) is forbidden. Use applyEvent(name, payload).'
    );
  });

  it('allows apply during rehydration and delegates to base', () => {
    const instance = new TestModel('aggregate-2', 200);
    (instance as any)._rehydrating = true;
    (instance as any).apply({ eventType: 'AnyEvent', payload: { a: 1 } });
    const recorded = (instance as any).getUncommittedEvents();
    expect(Array.isArray(recorded)).toBe(true);
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toEqual({ eventType: 'AnyEvent', payload: { a: 1 } });
  });

  it('applyEvent preserves payload identity and fills system fields', () => {
    const aggregateId = 'aggregate-3';
    const instance = new TestModel(aggregateId, 42);
    const payloadObject = { fieldOne: 'valueOne', nested: { x: 1 } };
    const blockHeight = 77;

    instance.exposedApplyEvent('SampleEvent', blockHeight, payloadObject);

    const recorded = (instance as any).getUncommittedEvents();
    expect(recorded.length).toBe(1);
    const eventInstance = recorded[0];
    expect(eventInstance.aggregateId).toBe(aggregateId);
    expect(eventInstance.requestId).toBe('fixed-request-id');
    expect(eventInstance.blockHeight).toBe(blockHeight);
    expect(eventInstance.payload).toBe(payloadObject);
  });
});
