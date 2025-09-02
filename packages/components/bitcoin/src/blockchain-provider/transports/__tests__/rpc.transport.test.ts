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

jest.mock('undici', () => {
  let createdCount = 0;
  class FakeDispatcher { constructor() { createdCount++; } close() {} destroy() {} }
  const Agent = jest.fn(() => new FakeDispatcher());
  const __createdCount = () => createdCount;
  return { Agent, __createdCount };
});

jest.mock('zeromq', () => {
  class Subscriber {
    connect(_e: string) {}
    subscribe(_t: string) {}
    close() {}
    [Symbol.asyncIterator]() { return queue[Symbol.asyncIterator](); }
  }
  return { Subscriber };
});

function makeTransport(overrides: Partial<ConstructorParameters<typeof RPCTransport>[0]> = {}) {
  const t: any = new RPCTransport({
    uniqName: 'rpc-test',
    baseUrl: 'http://user:pass@host',
    responseTimeout: 5000,
    rateLimits: { maxConcurrentRequests: 3, maxBatchSize: 50, requestDelayMs: 0 },
    network: { network: 'testnet', nativeCurrencySymbol: 'tBTC', hasSegWit: true },
    ...overrides,
  } as any);
  transportsCreated.push(t);
  return t;
}

describe('RPCTransport stability', () => {
  it('batchCall maps responses by id and preserves order with null fill', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return [
        { id: calls[2].id, result: 'C' },
        { id: calls[0].id, result: 'A' },
      ];
    };
    const out = await a.batchCall([
      { method: 'm1', params: [] },
      { method: 'm2', params: [] },
      { method: 'm3', params: [] },
    ]);
    expect(out).toEqual(['A', null, 'C']);
  });

  it('requestHexBlocks returns buffers and nulls preserving positions', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return calls.map((c: any, i: number) => ({ id: c.id, result: i === 1 ? null : 'abcd' }));
    };
    const hashes = ['h1', 'h2', 'h3', 'h4'];
    const res = await a.requestHexBlocks(hashes);
    expect(res.length).toBe(4);
    expect(Buffer.isBuffer(res[0])).toBe(true);
    expect(res[0]?.equals(Buffer.from('abcd', 'hex'))).toBe(true);
    expect(res[1]).toBeNull();
  });

  it('getManyBlockHashesByHeights preserves order and nulls', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return calls.map((c: any, i: number) => ({ id: c.id, result: i === 2 ? null : `hash-${i}` }));
    };
    const out = await a.getManyBlockHashesByHeights([0, 1, 2, 3]);
    expect(out).toEqual(['hash-0', 'hash-1', null, 'hash-3']);
  });

  it('subscribeToNewBlocks reads last frame and unsubscribe closes stream', async () => {
    const a = makeTransport({ zmqEndpoint: 'tcp://example:28332' });
    const received: Buffer[] = [];
    const sub = a.subscribeToNewBlocks((b: Buffer) => received.push(b));
    await new Promise((r) => setTimeout(r, 5));
    queue.push([Buffer.from('rawblock'), Buffer.from('00', 'hex'), Buffer.from('eeff', 'hex')]);
    await new Promise((r) => setTimeout(r, 5));
    expect(received.length).toBe(1);
    expect(received[0]?.equals(Buffer.from('eeff', 'hex'))).toBe(true);
    sub.unsubscribe();
    expect(a['zmqSocket']).toBeUndefined();
    queue.end();
  });

  it('uses a single created HTTP dispatcher for all instances', async () => {
    const { __createdCount } = jest.requireMock('undici') as { __createdCount: () => number };
    makeTransport();
    makeTransport();
    expect(__createdCount()).toBe(1);
  });
});
