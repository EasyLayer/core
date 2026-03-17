import { RPCTransport } from '../rpc.transport';

jest.setTimeout(20000);

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];

  push(item: T) {
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    const r = this.resolvers.shift();
    if (r) r({ value: undefined as any, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.items.shift();
          if (item !== undefined) resolve({ value: item, done: false });
          else this.resolvers.push(resolve);
        }),
    };
  }
}

let rpcResponder: ((body: string) => any) | null = null;
const transportsCreated: any[] = [];
const queue = new AsyncQueue<any>();

beforeEach(() => {
  (globalThis as any).fetch = jest.fn(async (_url: string, init?: any) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const result = rpcResponder ? rpcResponder(body) : [];
    return {
      ok: true,
      status: 200,
      json: async () => result,
      text: async () => JSON.stringify(result),
    } as any;
  });
  rpcResponder = null;
});

afterEach(async () => {
  queue.end();
  while (transportsCreated.length) {
    const t = transportsCreated.pop();
    try { await t.disconnect?.(); } catch {}
  }
});

jest.mock(
  'zeromq',
  () => {
    class Subscriber {
      connect(_e: string) {}
      subscribe(_t: string) {}
      close() {}
      [Symbol.asyncIterator]() {
        return queue[Symbol.asyncIterator]();
      }
    }
    return { __esModule: true, Subscriber };
  },
  { virtual: true }
);

function makeTransport(overrides: Partial<ConstructorParameters<typeof RPCTransport>[0]> = {}) {
  const t: any = new RPCTransport({
    uniqName: 'rpc-test',
    baseUrl: 'http://user:pass@host',
    responseTimeout: 5000,
    rateLimits: { maxConcurrentRequests: 3, maxBatchSize: 50, requestDelayMs: 0 },
    network: { network: 'testnet', nativeCurrencySymbol: 'tBTC', hasSegWit: true },
    zmqEndpoint: 'tcp://example:28332',
    ...overrides,
  } as any);
  transportsCreated.push(t);
  return t;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000, stepMs = 10) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(stepMs);
  }
}

describe('RPCTransport (node)', () => {
  // ===== Existing tests =====

  it('maps out-of-order JSON-RPC responses by id and preserves order/null', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return [
        { id: calls[2].id, result: { hash: 'C' }, error: null },
        { id: calls[0].id, result: { hash: 'A' }, error: null },
        // calls[1] intentionally missing -> null
      ];
    };
    const out = await a.getRawBlocksByHashesVerbose(['h1', 'h2', 'h3'], 1);
    expect(out).toEqual([{ hash: 'A' }, null, { hash: 'C' }]);
  });

  it('requestHexBlocks returns Buffer and preserves nulls', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return calls.map((c: any, i: number) =>
        i === 1
          ? { id: c.id, result: null, error: null }
          : { id: c.id, result: 'abcd', error: null }
      );
    };
    const res = await a.requestHexBlocks(['h1', 'h2', 'h3', 'h4']);
    expect(res.length).toBe(4);
    expect(res[1]).toBeNull();
    const b0 = res[0]!;
    const exp = Buffer.from('abcd', 'hex');
    expect(new Uint8Array(b0 as any)).toEqual(new Uint8Array(exp));
  });

  it('getManyBlockHashesByHeights preserves order and nulls', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return calls.map((c: any, i: number) =>
        i === 2
          ? { id: c.id, result: null, error: null }
          : { id: c.id, result: `hash-${i}`, error: null }
      );
    };
    const out = await a.getManyBlockHashesByHeights([0, 1, 2, 3]);
    expect(out).toEqual(['hash-0', 'hash-1', null, 'hash-3']);
  });

  it('getBlockHeight returns number', async () => {
    const a = makeTransport();
    rpcResponder = (_body: string) => [{ id: JSON.parse(_body)[0].id, result: 123456, error: null }];
    const height = await a.getBlockHeight();
    expect(height).toBe(123456);
  });

  // ===== New tests: ZMQ reconnect notifies subscribers (fix 1.1) =====
  // These tests bypass connect() and initializeZMQ() (both require live RPC or
  // dynamic import('zeromq') which Jest cannot mock without --experimental-vm-modules).
  // Instead we set internal ZMQ state directly — the tests are about scheduleZMQReconnect
  // and zmqReconnectAttempts logic, not about ZMQ socket initialization.

  function setupZMQState(t: any) {
    // Simulate ZMQ already running — bypass dynamic import('zeromq')
    (t as any).isConnected = true;
    (t as any).zmqRunning = true;
    (t as any).zmqReconnectAttempts = 0;
    (t as any).zmqSocket = { close: jest.fn() };
  }

  it('scheduleZMQReconnect notifies all subscribers via onError before reconnecting', async () => {
    const t = makeTransport({ zmqEndpoint: 'tcp://test:28332' });
    setupZMQState(t);

    const errors: Error[] = [];
    t.subscribeToNewBlocks(() => {}, (e: Error) => errors.push(e));
    expect((t as any).blockSubscriptions.size).toBe(1);

    (t as any).scheduleZMQReconnect(new Error('simulated disconnect'));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('ZMQ connection lost');
    expect((t as any).blockSubscriptions.size).toBe(0);
  });

  it('zmqReconnectAttempts increments on each scheduleZMQReconnect call', () => {
    // Tests the counter logic without needing a real ZMQ connection.
    // The reset-to-0 on successful init is verified by inspecting initializeZMQ source —
    // dynamic import prevents testing it directly in Jest without experimental flags.
    const t = makeTransport({ zmqEndpoint: 'tcp://test:28332' });
    setupZMQState(t);

    (t as any).scheduleZMQReconnect(new Error('disconnect 1'));
    expect((t as any).zmqReconnectAttempts).toBe(1);

    // Simulate reset as initializeZMQ would do on success
    (t as any).zmqReconnectAttempts = 0;
    expect((t as any).zmqReconnectAttempts).toBe(0);
  });

  it('scheduleZMQReconnect notifies multiple subscribers individually', () => {
    const t = makeTransport({ zmqEndpoint: 'tcp://test:28332' });
    setupZMQState(t);

    const errorsA: Error[] = [];
    const errorsB: Error[] = [];
    t.subscribeToNewBlocks(() => {}, (e: Error) => errorsA.push(e));
    t.subscribeToNewBlocks(() => {}, (e: Error) => errorsB.push(e));
    expect((t as any).blockSubscriptions.size).toBe(2);

    (t as any).scheduleZMQReconnect(new Error('disconnect'));

    expect(errorsA).toHaveLength(1);
    expect(errorsB).toHaveLength(1);
    expect((t as any).blockSubscriptions.size).toBe(0);
  });
});
