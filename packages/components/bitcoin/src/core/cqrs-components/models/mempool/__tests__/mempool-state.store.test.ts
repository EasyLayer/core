import { createMempoolStateStore, JsMempoolStateStore } from '../mempool-state.store';
import { setBitcoinNativeBindings, setBitcoinNativeLoadError } from '../../../../native';

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


describe('NativeMempoolStateAdapter contract', () => {
  afterEach(() => {
    setBitcoinNativeBindings(undefined);
  });


  it('requires native mempool store instead of falling back to JS', () => {
    setBitcoinNativeBindings(undefined);
    setBitcoinNativeLoadError(new Error('native addon missing in test'));

    expect(() => createMempoolStateStore()).toThrow(/NativeMempoolState requires the Bitcoin Rust native addon/);
    expect(() => createMempoolStateStore()).toThrow(/native addon missing in test/);
  });

  it('fails immediately when a selected native store lacks required methods', () => {
    class IncompleteNativeMempoolState {
      applySnapshot() {}
      providers() { return []; }
      pendingTxids() { return []; }
      recordLoaded() {}
      *txIds() {}
      *loadedTransactions() {}
      *metadata() {}
      hasTransaction() { return false; }
      isTransactionLoaded() { return false; }
      getTransactionMetadata() { return undefined; }
      getFullTransaction() { return undefined; }
      getStats() { return { txids: 0, metadata: 0, transactions: 0, providers: 0 }; }
      getMemoryUsage() {
        return { unit: 'MB', counts: { txids: 0, metadata: 0, transactions: 0, loaded: 0, providers: 0 }, bytes: { txIndex: 0, metadata: 0, txStore: 0, loadTracker: 0, providerTx: 0, total: 0 } };
      }
      exportSnapshot() { return { version: 2, txids: [], providerTx: [], metadata: [], transactions: [], loadTracker: [] }; }
      importSnapshot() {}
      dispose() {}
    }

    setBitcoinNativeBindings({ NativeMempoolState: IncompleteNativeMempoolState as any });

    expect(() => createMempoolStateStore()).toThrow(/missing required method\(s\): mergeSnapshot, removeTxids/);
  });

  it('does not silently fall back to JS when a selected native store fails to initialize', () => {
    class ThrowingNativeMempoolState {
      constructor() {
        throw new Error('native allocation failed');
      }
    }

    setBitcoinNativeBindings({ NativeMempoolState: ThrowingNativeMempoolState as any });

    expect(() => createMempoolStateStore()).toThrow(
      /NativeMempoolState binding was selected but failed to initialize: native allocation failed/
    );
  });



  it('uses a complete native store and delegates required incremental methods', () => {
    const calls: string[] = [];

    class CompleteNativeMempoolState extends JsMempoolStateStore {
      mergeSnapshot(snapshot: any) {
        calls.push('mergeSnapshot');
        super.mergeSnapshot(snapshot);
      }

      removeTxids(txids: string[]) {
        calls.push('removeTxids');
        super.removeTxids(txids);
      }
    }

    setBitcoinNativeBindings({ NativeMempoolState: CompleteNativeMempoolState as any });

    const store = createMempoolStateStore();
    const txid = 'd'.repeat(64);
    store.mergeSnapshot({ providerA: [{ txid, metadata: meta(txid) }] });
    expect(store.hasTransaction(txid)).toBe(true);

    store.removeTxids([txid]);
    expect(store.hasTransaction(txid)).toBe(false);
    expect(calls).toEqual(['mergeSnapshot', 'removeTxids']);
  });


  // it('accepts native snake_case method names without falling back to JS', () => {
  //   const calls: string[] = [];

  //   class SnakeCaseNativeMempoolState extends JsMempoolStateStore {
  //     merge_snapshot(snapshot: any) {
  //       calls.push('merge_snapshot');
  //       super.mergeSnapshot(snapshot);
  //     }

  //     remove_txids(txids: string[]) {
  //       calls.push('remove_txids');
  //       super.removeTxids(txids);
  //     }
  //   }

  //   setBitcoinNativeBindings({ NativeMempoolState: SnakeCaseNativeMempoolState as any });

  //   const store = createMempoolStateStore();
  //   const txid = 'e'.repeat(64);
  //   store.mergeSnapshot({ providerA: [{ txid, metadata: meta(txid) }] });
  //   expect(store.hasTransaction(txid)).toBe(true);

  //   store.removeTxids([txid]);
  //   expect(store.hasTransaction(txid)).toBe(false);
  //   expect(calls).toEqual(['merge_snapshot', 'remove_txids']);
  // });

  it('preserves optional metadata values as undefined rather than inventing zero defaults', () => {
    const store = new JsMempoolStateStore();
    const txid = 'c'.repeat(64);
    store.applySnapshot({ providerA: [{ txid, metadata: { txid, fees: {} } as any }] });

    const metadata = store.getTransactionMetadata(txid)!;
    expect(metadata.vsize).toBeUndefined();
    expect(metadata.fee).toBeUndefined();
    expect(metadata.height).toBeUndefined();
    expect(metadata.fees.base).toBeUndefined();
  });
});
