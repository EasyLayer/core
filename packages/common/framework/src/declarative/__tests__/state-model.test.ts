import { StateModel } from '../state-model';

jest.mock('../../model', () => {
  class ModelMock {
    public aggregateId: string | undefined;
    public lastBlockHeight: number | undefined;
    public overrideArgs: any;
    constructor(aggregateId?: string, lastBlockHeight?: number, override?: any) {
      this.aggregateId = aggregateId;
      this.lastBlockHeight = lastBlockHeight;
      this.overrideArgs = override;
    }
  }
  return { Model: ModelMock };
});

class ConcreteStateModel<State> extends StateModel<State> {
  public async processBlock(): Promise<void> {}
}

describe('StateModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes constructor arguments and builds empty snapshotAdapters when not provided', () => {
    const instance = new ConcreteStateModel<any>('agg-1', 10);
    const base: any = instance as any;
    expect(base.aggregateId).toBe('agg-1');
    expect(base.lastBlockHeight).toBe(10);
    expect(base.overrideArgs).toBeDefined();
    expect(base.overrideArgs.snapshotAdapters).toEqual({});
  });

  it('merges snapshotAdapters from options without altering the original object', () => {
    const providedAdapters = {
      fieldA: { toJSON: (v: any) => v, fromJSON: (r: any) => r },
    };
    const options = { snapshotAdapters: providedAdapters, extra: { keep: true } };
    const instance = new ConcreteStateModel<any>('agg-2', 20, options);
    const base: any = instance as any;
    expect(base.overrideArgs.snapshotAdapters).toEqual(providedAdapters);
    expect(base.overrideArgs.snapshotAdapters).not.toBe(providedAdapters);
    expect(base.overrideArgs.extra).toEqual({ keep: true });
  });

  it('initializes state from function and preserves identity of the returned object', () => {
    const initialStateObject = { counter: 0, list: [] as number[] };
    const instance = new ConcreteStateModel<typeof initialStateObject>('agg-3', 30, {
      initialState: () => initialStateObject,
    });
    expect(instance.state).toBe(initialStateObject);
  });

  it('initializes state from object and preserves identity of the provided object', () => {
    const initialStateObject = { ready: true };
    const instance = new ConcreteStateModel<typeof initialStateObject>('agg-4', 40, {
      initialState: initialStateObject,
    });
    expect(instance.state).toBe(initialStateObject);
  });

  it('initializes state as a new empty object when no initialState is provided', () => {
    const a = new ConcreteStateModel<any>('agg-5', 50);
    const b = new ConcreteStateModel<any>('agg-6', 60);
    expect(a.state).toEqual({});
    expect(b.state).toEqual({});
    expect(a.state).not.toBe(b.state);
  });

  it('serializeUserState returns an empty object', () => {
    const instance = new ConcreteStateModel<any>('agg-7', 70);
    const result = (instance as any).serializeUserState();
    expect(result).toEqual({});
  });

  it('restoreUserState replaces state when revived contains state key and preserves identity', () => {
    const instance = new ConcreteStateModel<any>('agg-8', 80, { initialState: { a: 1 } });
    const revivedStateObject = { x: 1, y: 2 };
    const revivedPayload = { state: revivedStateObject, other: 'ignored' };
    (instance as any).restoreUserState(revivedPayload);
    expect(instance.state).toBe(revivedStateObject);
  });

  it('restoreUserState does nothing when revived is null or has no state key', () => {
    const initial = { a: 1 };
    const instance = new ConcreteStateModel<any>('agg-9', 90, { initialState: initial });
    (instance as any).restoreUserState(null);
    expect(instance.state).toBe(initial);
    (instance as any).restoreUserState({ something: 123 });
    expect(instance.state).toBe(initial);
  });
});
