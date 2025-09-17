import { RPCTransport } from '../rpc.transport';

jest.setTimeout(20000);

/** Simple async queue to drive async-iterable ZMQ mock */
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
    try {
      await t.disconnect?.();
    } catch {}
  }
});

/**
 * Dynamic import('zeromq') mock.
 */
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

function makeTransport(
  overrides: Partial<ConstructorParameters<typeof RPCTransport>[0]> = {}
) {
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

describe('RPCTransport (isomorphic)', () => {
  it('batchCall maps responses by id and preserves order with null fill', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return [
        { id: calls[2].id, result: 'C', error: null },
        { id: calls[0].id, result: 'A', error: null },
      ];
    };
    const out = await a.batchCall([
      { method: 'm1', params: [] },
      { method: 'm2', params: [] },
      { method: 'm3', params: [] },
    ]);
    expect(out).toEqual(['A', null, 'C']);
  });

  it('requestHexBlocks returns Buffer (Node/Electron) or buffer-like (browser) and preserves nulls', async () => {
    const a = makeTransport();
    rpcResponder = (body: string) => {
      const calls = JSON.parse(body);
      return calls.map((c: any, i: number) =>
        i === 1
          ? { id: c.id, result: null, error: null }
          : { id: c.id, result: 'abcd', error: null }
      );
    };
    const hashes = ['h1', 'h2', 'h3', 'h4'];
    const res = await a.requestHexBlocks(hashes);
    expect(res.length).toBe(4);

    const b0 = res[0]!;
    const expected = Buffer.from('abcd', 'hex');
    const a0 = new Uint8Array(b0 as any);
    const aExp = new Uint8Array(expected);
    expect(a0.length).toBe(aExp.length);
    for (let i = 0; i < a0.length; i++) expect(a0[i]).toBe(aExp[i]);

    expect(res[1]).toBeNull();
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

  // it('subscribeToNewBlocks reads last ZMQ frame and unsubscribe closes stream', async () => {
  //   const a = makeTransport({ zmqEndpoint: 'tcp://example:28332' });
  //   await a.connect();
  //   const received: Buffer[] = [];
  //   const sub = a.subscribeToNewBlocks((b: Buffer) => received.push(b));

  //   await waitFor(() => (a as any)['zmqRunning'] === true, 2000, 10);

  //   queue.push([Buffer.from('rawblock'), Buffer.from('00', 'hex'), Buffer.from('eeff', 'hex')]);

  //   await waitFor(() => received.length > 0, 1000, 10);

  //   const got = new Uint8Array(received[0] as any);
  //   const exp = new Uint8Array(Buffer.from('eeff', 'hex'));
  //   expect([...got]).toEqual([...exp]);

  //   sub.unsubscribe();
  //   expect((a as any)['zmqSocket']).toBeUndefined();
  // });
});
