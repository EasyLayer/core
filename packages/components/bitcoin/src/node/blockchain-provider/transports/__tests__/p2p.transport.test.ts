import { P2PTransport } from '../p2p.transport';

jest.setTimeout(20000);

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
    listenerCount(e: string) { return (this.handlers[e] || []).length; }
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
      headerSyncEnabled: false,
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

  // ===== Existing tests =====

  it('connect establishes active peer', async () => {
    const t = makeTransport();
    await t.connect();
    expect(t['connected']).toBe(true);
    expect(t['activePeer']).not.toBeNull();
  });

  it('getManyBlockHashesByHeights preserves order and nulls from local header map', async () => {
    const t = makeTransport();
    await t.connect();
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
    expect(out[2]).toBeNull(); // c was not emitted by mock
  });

  it('getBlockHeight returns number from checkpoint', async () => {
    const t = makeTransport({ headerSyncEnabled: false });
    await t.connect();
    const h = await t.getBlockHeight();
    expect(typeof h).toBe('number');
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it('subscribeToNewBlocks delivers raw buffers and supports unsubscribe', async () => {
    const t = makeTransport();
    await t.connect();
    const received: Buffer[] = [];
    const sub = t.subscribeToNewBlocks((b: Buffer) => received.push(b));

    await new Promise((r) => setTimeout(r, 5));
    const peer: any = t['activePeer'];
    peer.emit('block', {
      block: {
        hash: Buffer.from('aa'.repeat(32), 'hex'),
        toBuffer: () => Buffer.from('abcd', 'hex'),
      },
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(received.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(received[0])).toBe(true);
    sub.unsubscribe();
  });

  it('requestHexBlocks: listener is removed after blocks arrive (no leak)', async () => {
    const t = makeTransport();
    await t.connect();
    const peer: any = t['activePeer'];

    const a = '11'.repeat(32);
    const b = '22'.repeat(32);
    const listenersBefore = peer.listenerCount('block');

    const resultPromise = t.requestHexBlocks([a, b]);
    // Give it time to start listening
    await new Promise((r) => setTimeout(r, 30));
    await resultPromise;

    // After blocks arrive and done() resolves, listener must be removed
    const listenersAfter = peer.listenerCount('block');
    expect(listenersAfter).toBe(listenersBefore);
  });

  it('requestHexBlocks: returns nulls for all if peer is null (no active peer)', async () => {
    const t = makeTransport();
    // Don't connect — activePeer stays null
    const out = await t.requestHexBlocks(['11'.repeat(32), '22'.repeat(32)]);
    expect(out).toEqual([null, null]);
  });

  // ===== New tests for P2P status methods (3.2) =====

  describe('isHeaderSyncComplete()', () => {
    it('returns false before header sync runs', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      await t.connect();
      const result = await t.isHeaderSyncComplete();
      expect(result).toBe(false);
    });

    it('returns true after header sync completes', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      // Manually force complete flag
      t['headerSyncComplete'] = true;
      const result = await t.isHeaderSyncComplete();
      expect(result).toBe(true);
    });
  });

  describe('getHeaderSyncProgress()', () => {
    it('returns zero total and percentage while syncing', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      await t.connect();
      t['chainTracker'].addHeader('aa'.repeat(32), 1);

      const progress = await t.getHeaderSyncProgress();
      expect(progress.synced).toBe(2); // checkpoint + 1 added header
      expect(progress.total).toBe(0);  // total unknown while not complete
      expect(progress.percentage).toBe(0);
    });

    it('returns 100% when sync is complete', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      t['headerSyncComplete'] = true;
      t['chainTracker'].addHeader('aa'.repeat(32), 1);

      const progress = await t.getHeaderSyncProgress();
      expect(progress.percentage).toBe(100);
      expect(progress.total).toBe(progress.synced);
      expect(progress.synced).toBeGreaterThan(0);
    });
  });

  describe('waitForHeaderSync()', () => {
    it('resolves immediately when already complete', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      t['headerSyncComplete'] = true;
      await expect(t.waitForHeaderSync(1000)).resolves.toBeUndefined();
    });

    it('throws when headerSyncEnabled is false and sync was never started', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      t['headerSyncComplete'] = false;
      t['headerSyncPromise'] = null;
      await expect(t.waitForHeaderSync(100)).rejects.toThrow('header sync was not started');
    });

    it('times out when sync does not complete in time', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      t['headerSyncComplete'] = false;
      // Hang forever — never resolves
      t['headerSyncPromise'] = new Promise(() => {});

      await expect(t.waitForHeaderSync(50)).rejects.toThrow('header sync timed out after 50ms');
    });

    it('resolves when headerSyncPromise resolves', async () => {
      const t = makeTransport({ headerSyncEnabled: false });
      t['headerSyncComplete'] = false;
      let resolveSync!: () => void;
      t['headerSyncPromise'] = new Promise<void>((res) => { resolveSync = res; });

      const waitPromise = t.waitForHeaderSync(2000);
      resolveSync();
      await expect(waitPromise).resolves.toBeUndefined();
    });
  });
});
