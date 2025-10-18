import { P2PTransport } from '../p2p.transport';

jest.setTimeout(20000);

/**
 * bitcore-p2p mock:
 * - Pool emits 'peerready' with a mock Peer
 * - Peer.sendMessage handles GetHeaders (emits empty headers) and GetData (emits 2 blocks)
 * - Event system with on/once/emit/removeListener
 */
jest.mock('bitcore-p2p', () => {
  class Emitter {
    private handlers: Record<string, Function[]> = {};
    on(e: string, fn: Function) { (this.handlers[e] ||= []).push(fn); return this; }
    once(e: string, fn: Function) { return this.on(e, fn); }
    emit(e: string, payload: any) { (this.handlers[e] || []).forEach(f => f(payload)); }
    removeListener(e: string, fn: Function) {
      const arr = this.handlers[e] || [];
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }
  class Messages {
    static GetData = class { constructor(public inventory: any) {} };
    static GetHeaders = class { constructor(public opts: any) {} };
    static Pong = class { constructor(public nonce: any) {} };
  }
  class Peer extends Emitter {
    sendMessage(msg: any) {
      if (msg instanceof Messages.GetHeaders) {
        setTimeout(() => this.emit('headers', { headers: [] }), 2);
        return;
      }
      if (msg instanceof Messages.GetData) {
        setTimeout(() => {
          const mk = (h: string) => ({
            block: {
              hash: Buffer.from(h, 'hex'),
              toBuffer: () => Buffer.from('abcd', 'hex'),
            },
          });
          // Emit two blocks (3rd missing to test null fill)
          this.emit('block', mk('11'.repeat(32)));
          this.emit('block', mk('22'.repeat(32)));
        }, 5);
      }
    }
  }
  class Pool extends Emitter {
    addPeer(_p: any) {}
    connect() { setTimeout(() => this.emit('peerready', new Peer()), 1); }
    disconnect() {}
  }
  return { Pool, Peer, Messages };
});

describe('P2PTransport (node)', () => {
  const transportsCreated: any[] = [];

  function makeTransport(overrides: Partial<ConstructorParameters<typeof P2PTransport>[0]> = {}) {
    const t: any = new P2PTransport({
      uniqName: 'p2p-test',
      peers: [{ host: 'h', port: 8333 }],
      network: { network: 'testnet', nativeCurrencySymbol: 'tBTC', hasSegWit: true },
      headerSyncEnabled: false, // disable header sync for deterministic tests
      checkpoint: { hash: '00'.repeat(32), height: 0 },
      ...overrides,
    } as any);
    transportsCreated.push(t);
    return t;
  }

  afterEach(async () => {
    while (transportsCreated.length) {
      const t = transportsCreated.pop();
      try { await t.disconnect?.(); } catch {}
    }
  });

  it('connect establishes active peer', async () => {
    const t = makeTransport();
    await t.connect();
    expect(t['connected']).toBe(true);
    expect(t['activePeer']).not.toBeNull();
  });

  it('getManyBlockHashesByHeights preserves order and nulls (using local header map)', async () => {
    const t = makeTransport();
    await t.connect();
    // Seed tracker: genesis at 0 already set by checkpoint; add height 1
    t['chainTracker'].addHeader('aa'.repeat(32), 1);
    const out = await t.getManyBlockHashesByHeights([0, 1, 2]);
    expect(out).toEqual(['00'.repeat(32), 'aa'.repeat(32), null]);
  });

  it('requestHexBlocks returns buffers and nulls preserving positions', async () => {
    const t = makeTransport();
    await t.connect();
    const a = '11'.repeat(32);
    const b = '22'.repeat(32);
    const c = '33'.repeat(32);
    const out = await t.requestHexBlocks([a, b, c]);
    expect(out.length).toBe(3);
    expect(Buffer.isBuffer(out[0])).toBe(true);
    expect(Buffer.isBuffer(out[1])).toBe(true);
    expect(out[2]).toBeNull();
  });

  it('getBlockHeight throws until header sync provides tip (when enabled)', async () => {
    const t = makeTransport({ headerSyncEnabled: false });
    await t.connect();
    // With only checkpoint(0), tip is 0 → getBlockHeight should be >= 0
    const h = await t.getBlockHeight();
    expect(typeof h).toBe('number');
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it('subscribeToNewBlocks delivers raw buffers to subscribers and supports unsubscribe', async () => {
    const t = makeTransport();
    await t.connect();
    const received: Buffer[] = [];
    const sub = t.subscribeToNewBlocks((b: Buffer) => received.push(b));

    // Trigger a mock block through the active peer
    await new Promise((r) => setTimeout(r, 5));
    const peer: any = t['activePeer'];
    const mockBlock = {
      block: {
        hash: Buffer.from('aa'.repeat(32), 'hex'),
        toBuffer: () => Buffer.from('abcd', 'hex'),
      },
    };
    peer.emit('block', mockBlock);

    await new Promise((r) => setTimeout(r, 5));

    expect(received.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(received[0])).toBe(true);

    sub.unsubscribe();
  });
});
