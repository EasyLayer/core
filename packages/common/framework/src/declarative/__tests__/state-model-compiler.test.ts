import { compileStateModel } from '../state-model-compiler';
import { Model } from '../../model';

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'fixed-request-id'),
}));

jest.mock('@easylayer/common/cqrs', () => {
  class BasicEvent {
    aggregateId: string;
    requestId: string;
    blockHeight: number;
    timestamp: number | undefined;
    payload: any;
    constructor(system: { aggregateId: string; requestId: string; blockHeight: number; timestamp?: number }, payload: any) {
      this.aggregateId = system.aggregateId;
      this.requestId = system.requestId;
      this.blockHeight = system.blockHeight;
      this.timestamp = system.timestamp;
      this.payload = payload;
    }
  }
  class AggregateRoot {
    public recordedEvents: any[] = [];
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

describe('compileStateModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('produces a named constructor and sets static modelName', () => {
    const declarative = {
      name: 'Counter',
      state: () => ({ count: 0 }),
      reducers: {},
      sources: {},
      options: {},
    };
    const walker = async () => {};
    const Compiled = compileStateModel(declarative as any, walker as any);
    expect(typeof Compiled).toBe('function');
    expect((Compiled as any).name).toBe('CounterModel');
    expect((Compiled as any).modelName).toBe('Counter');
  });

  it('initializes state from factory and allows reducers to mutate state', () => {
    const declarative = {
      name: 'ReducerModel',
      state: () => ({ value: 1 }),
      reducers: {
        Increment(this: any, e: any) {
          this.state.value += e.delta;
        },
      },
      sources: {},
      options: {},
    };
    const walker = async () => {};
    const Compiled = compileStateModel(declarative as any, walker as any);
    const instance = new (Compiled as any)('agg-1', 0);
    expect(instance).toBeInstanceOf(Model);
    expect(instance.state).toEqual({ value: 1 });
    instance['onIncrement']({ delta: 3 });
    expect(instance.state).toEqual({ value: 4 });
  });

  it('processBlock calls walker for each source and injects state and applyEvent via prototype without mutating input context', async () => {
    const payloadReference = { k: 'v' };
    const eventsFrom = ['srcA', 'srcB'];
    const declarative = {
      name: 'WalkerModel',
      state: () => ({ m: 7 }),
      reducers: {},
      sources: {
        a: {
          from: 'srcA',
          handler: async (context: any) => {
            expect(context.state).toBeDefined();
            expect(context.state.m).toBe(7);
            expect(typeof context.applyEvent).toBe('function');
            context.applyEvent('EvtA', context.block.height, payloadReference);
          },
        },
        b: {
          from: 'srcB',
          handler: async (context: any) => {
            expect(context.state).toBeDefined();
            expect(context.state.m).toBe(7);
            expect(typeof context.applyEvent).toBe('function');
            context.applyEvent('EvtB', context.block.height, payloadReference);
          },
        },
      },
      options: {},
    };

    const walked: Array<{ from: string }> = [];
    const walker = async (from: string, block: any, fn: (ctx: any) => void | Promise<void>) => {
      walked.push({ from });
      const subContext = { sub: true };
      await fn(subContext);
    };

    const Compiled = compileStateModel(declarative as any, walker as any);
    const aggregateId = 'agg-w';
    const instance = new (Compiled as any)(aggregateId, 10);

    const inputContext = { block: { height: 123 }, foo: 'bar' };
    await instance.processBlock(inputContext as any);

    expect(walked.map(x => x.from)).toEqual(eventsFrom);

    const recorded = (instance as any).getUncommittedEvents();
    expect(Array.isArray(recorded)).toBe(true);
    expect(recorded.length).toBe(2);
    expect(recorded[0].aggregateId).toBe(aggregateId);
    expect(recorded[0].requestId).toBe('fixed-request-id');
    expect(recorded[0].blockHeight).toBe(123);
    expect(recorded[0].payload).toBe(payloadReference);
    expect(recorded[1].aggregateId).toBe(aggregateId);
    expect(recorded[1].blockHeight).toBe(123);
    expect(recorded[1].payload).toBe(payloadReference);

    expect(Object.prototype.hasOwnProperty.call(inputContext, 'state')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(inputContext, 'applyEvent')).toBe(false);
    expect(inputContext).toEqual({ block: { height: 123 }, foo: 'bar' });
  });

  it('constructor merges options and supports default aggregateId and lastBlockHeight values', () => {
    const declarative = {
      name: 'DefaultsModel',
      state: { ok: true },
      reducers: {},
      sources: {},
      options: { a: 1 },
    };
    const walker = async () => {};
    const Compiled = compileStateModel(declarative as any, walker as any);
    const instance = new (Compiled as any)(undefined as any, undefined as any, { options: { b: 2 } });
    expect(instance.aggregateId).toBe('DefaultsModel');
    expect(instance.lastBlockHeight).toBe(-1);
  });
});
