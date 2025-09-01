import { normalizeModels } from '../normalizer';

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
    apply(e: any) { this.recordedEvents.push(e); }
    getUncommittedEvents() { return this.recordedEvents; }
    loadFromHistory(events: any[]) { for (const e of events) this.apply(e); }
  }
  return { BasicEvent, AggregateRoot, AggregateOptions: {} as any };
});

jest.mock('../declarative/state-model-compiler', () => {
  return {
    compileStateModel: jest.fn((declarative: any, walker: any) => {
      return class CompiledStateModel {
        public state: any = typeof declarative.state === 'function' ? declarative.state() : declarative.state;
        public receivedWalker = walker;
        public static modelName = declarative.name;
        async processBlock(): Promise<void> {}
      };
    }),
  };
});

class ConcreteModel {
  async processBlock(): Promise<void> {}
}

describe('normalizeModels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the same constructor for class-based input', () => {
    const walker = async () => {};
    const result = normalizeModels([ConcreteModel as any], walker as any);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(ConcreteModel);
  });

  it('compiles a declarative model and injects walker', () => {
    const declarative = {
      name: 'Counter',
      state: () => ({ count: 0, items: [] as number[] }),
      sources: { '*': { from: '*', handler: async () => {} } },
      reducers: { onIncrement() {} },
      options: {},
    };
    const walker = async () => {};
    const [Ctor] = normalizeModels([declarative as any], walker as any);
    const instance = new (Ctor as any)('agg-1', 0);

    expect(typeof (Ctor as any).modelName).toBe('string');
    expect((Ctor as any).modelName).toBe('Counter');

    expect(instance).toBeDefined();
    expect(typeof (instance as any).processBlock).toBe('function');
    expect((instance as any).state).toEqual({ count: 0, items: [] });
    expect((instance as any).receivedWalker).toBe(walker);
  });

  it('throws on unsupported provider type', () => {
    const walker = async () => {};
    expect(() => normalizeModels([123 as any], walker as any)).toThrow('Unsupported model provider: 123');
  });

  it('handles mixed inputs preserving order', () => {
    const declarative = {
      name: 'D',
      state: { ok: true },
      sources: { '*': { from: '*', handler: async () => {} } },
      reducers: {},
      options: {},
    };
    const walker = async () => {};
    const result = normalizeModels([ConcreteModel as any, declarative as any, ConcreteModel as any], walker as any);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(ConcreteModel);
    expect(typeof result[1]).toBe('function');
    expect(result[2]).toBe(ConcreteModel);

    const compiled = new (result[1] as any)('a', 1);
    expect((compiled as any).state).toEqual({ ok: true });
    expect(typeof (compiled as any).processBlock).toBe('function');
  });
});
