import { JsEvmMempoolStateStore } from '../mempool-state.store';
import type { MempoolTxMetadata } from '../../../../blockchain-provider/providers/interfaces';

const tx = (from: string, nonce: number, gasPrice = '100', gas = 21_000) => ({
  hash: `0x${nonce.toString(16).padStart(64, '0')}`,
  from,
  nonce,
  gasPrice,
  gas,
  to: `0x${'b'.repeat(40)}`,
  value: '0',
}) satisfies MempoolTxMetadata;

describe('JsEvmMempoolStateStore', () => {
  let store: JsEvmMempoolStateStore;

  beforeEach(() => {
    store = new JsEvmMempoolStateStore();
  });

  it('applies snapshot and preserves provider mapping', () => {
    store.applySnapshot({
      providerA: [{ hash: '0x01', metadata: tx(`0x${'a'.repeat(40)}`, 1) }],
      providerB: [{ hash: '0x02', metadata: tx(`0x${'c'.repeat(40)}`, 2) }],
    });

    expect(store.providers()).toEqual(expect.arrayContaining(['providerA', 'providerB']));
    expect(store.hasTransaction('0x01')).toBe(true);
    expect(store.hasTransaction('0x02')).toBe(true);
  });

  it('tracks replacement candidates by (from, nonce)', () => {
    const from = `0x${'d'.repeat(40)}`;
    store.applySnapshot({
      providerA: [{ hash: '0x03', metadata: tx(from, 7, '100') }],
    });

    const candidate = store.getReplacementCandidate(from.toUpperCase(), 7);
    expect(candidate?.hash).toBe('0x03');
    expect(candidate?.metadata.nonce).toBe(7);
  });

  it('records loaded transactions and round-trips snapshot export/import', () => {
    store.applySnapshot({
      providerA: [{ hash: '0x04', metadata: tx(`0x${'e'.repeat(40)}`, 4) }],
    });
    store.recordLoaded([{ hash: '0x04', metadata: tx(`0x${'e'.repeat(40)}`, 4), providerName: 'providerA' }]);

    const restored = new JsEvmMempoolStateStore();
    restored.importSnapshot(store.exportSnapshot());

    expect(restored.hasTransaction('0x04')).toBe(true);
    expect(restored.isTransactionLoaded('0x04')).toBe(true);
  });

  it('prunes loaded transactions by ttl', () => {
    store.applySnapshot({
      providerA: [{ hash: '0x05', metadata: tx(`0x${'f'.repeat(40)}`, 5) }],
    });
    store.recordLoaded([{ hash: '0x05', metadata: tx(`0x${'f'.repeat(40)}`, 5), providerName: 'providerA' }]);

    const removed = store.pruneTtl(1, Date.now() + 10);
    expect(removed).toBe(1);
    expect(store.hasTransaction('0x05')).toBe(false);
  });
});
