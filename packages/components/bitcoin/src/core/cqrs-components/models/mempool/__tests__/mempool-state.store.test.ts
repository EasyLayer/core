import { JsMempoolStateStore } from '../mempool-state.store';

const meta = (txid: string, fee = 1000): any => ({
  txid,
  vsize: 100,
  weight: 400,
  fee,
  modifiedfee: fee,
  time: 1,
  height: 0,
  depends: [],
  descendantcount: 0,
  descendantsize: 0,
  descendantfees: 0,
  ancestorcount: 0,
  ancestorsize: 0,
  ancestorfees: 0,
  fees: { base: fee, modified: fee, ancestor: fee, descendant: fee },
  bip125_replaceable: false,
});

const tx = (txid: string): any => ({
  txid,
  hash: txid,
  version: 2,
  size: 120,
  strippedsize: 100,
  sizeWithoutWitnesses: 100,
  vsize: 100,
  weight: 400,
  locktime: 0,
  vin: [],
  vout: [],
  feeRate: 10,
});

describe('JsMempoolStateStore', () => {
  it('stores different txids independently by full txid value', () => {
    const store = new JsMempoolStateStore();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);

    store.applySnapshot({ providerA: [{ txid: a, metadata: meta(a) }, { txid: b, metadata: meta(b) }] });

    expect(store.hasTransaction(a)).toBe(true);
    expect(store.hasTransaction(b)).toBe(true);
    expect(store.getStats()).toEqual({ txids: 2, metadata: 2, transactions: 0, providers: 1 });
    expect(store.pendingTxids('providerA', 10)).toEqual([a, b]);
  });

  it('preserves loaded transactions that are still present after refresh', () => {
    const store = new JsMempoolStateStore();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);

    store.applySnapshot({ providerA: [{ txid: a, metadata: meta(a) }, { txid: b, metadata: meta(b) }] });
    store.recordLoaded([{ txid: a, transaction: tx(a), providerName: 'providerA' }]);

    store.applySnapshot({ providerA: [{ txid: a, metadata: meta(a) }] });

    expect(store.isTransactionLoaded(a)).toBe(true);
    expect(store.getFullTransaction(a)?.txid).toBe(a);
    expect(store.hasTransaction(b)).toBe(false);
  });

  it('exports and restores v2 snapshots', () => {
    const a = 'a'.repeat(64);
    const source = new JsMempoolStateStore();
    source.applySnapshot({ providerA: [{ txid: a, metadata: meta(a) }] });
    source.recordLoaded([{ txid: a, transaction: tx(a), providerName: 'providerA' }]);

    const restored = new JsMempoolStateStore();
    restored.importSnapshot(source.exportSnapshot());

    expect(restored.hasTransaction(a)).toBe(true);
    expect(restored.isTransactionLoaded(a)).toBe(true);
    expect(restored.getTransactionMetadata(a)?.txid).toBe(a);
    expect(restored.getFullTransaction(a)?.txid).toBe(a);
  });

  it('rejects unsupported legacy hash32 snapshots', () => {
    const store = new JsMempoolStateStore();

    expect(() =>
      store.importSnapshot({
        txIndex_h2s: new Map([[123, 'a'.repeat(64)]]),
        providerTx_map: new Map([['providerA', new Set([123])]]),
      })
    ).toThrow('Unsupported mempool snapshot format');
  });
});
