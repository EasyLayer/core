import {
  TxHashIndex,
  MetadataStore,
  LoadTracker,
  NonceIndex,
  ProviderTxMap,
  BatchSizer,
} from '../components';
import type { MempoolTxMetadata } from '../../../../blockchain-provider/providers/interfaces';

function makeMeta(overrides: Partial<MempoolTxMetadata> = {}): MempoolTxMetadata {
  return {
    hash: '0x' + 'e'.repeat(64),
    from: '0x' + 'a'.repeat(40),
    to: '0x' + 'b'.repeat(40),
    nonce: 1,
    value: '0',
    gas: 21000,
    gasPrice: '1000000000',
    type: '0x0',
    ...overrides,
  };
}

describe('TxHashIndex', () => {
  let idx: TxHashIndex;
  const hash1 = '0x' + 'a'.repeat(64);
  const hash2 = '0x' + 'b'.repeat(64);

  beforeEach(() => { idx = new TxHashIndex(); });

  it('adds hash and returns numeric id', () => {
    const id = idx.add(hash1);
    expect(typeof id).toBe('number');
    expect(idx.getByHash(hash1)).toBe(id);
    expect(idx.getById(id)).toBe(hash1);
  });

  it('returns same id on duplicate add', () => {
    const id1 = idx.add(hash1);
    const id2 = idx.add(hash1);
    expect(id1).toBe(id2);
  });

  it('assigns different ids to different hashes', () => {
    const id1 = idx.add(hash1);
    const id2 = idx.add(hash2);
    expect(id1).not.toBe(id2);
  });

  it('has() returns correct results', () => {
    idx.add(hash1);
    expect(idx.has(hash1)).toBe(true);
    expect(idx.has(hash2)).toBe(false);
  });

  it('remove() clears both maps', () => {
    const id = idx.add(hash1);
    idx.remove(hash1);
    expect(idx.has(hash1)).toBe(false);
    expect(idx.getById(id)).toBeUndefined();
    expect(idx.size()).toBe(0);
  });

  it('size() tracks correctly', () => {
    expect(idx.size()).toBe(0);
    idx.add(hash1);
    expect(idx.size()).toBe(1);
    idx.add(hash2);
    expect(idx.size()).toBe(2);
    idx.remove(hash1);
    expect(idx.size()).toBe(1);
  });
});

describe('MetadataStore', () => {
  let store: MetadataStore;

  beforeEach(() => { store = new MetadataStore(); });

  it('stores and retrieves metadata by id', () => {
    const meta = makeMeta();
    store.set(1, meta);
    expect(store.get(1)).toEqual(meta);
  });

  it('has() returns correct results', () => {
    store.set(1, makeMeta());
    expect(store.has(1)).toBe(true);
    expect(store.has(99)).toBe(false);
  });

  it('remove() deletes entry', () => {
    store.set(1, makeMeta());
    store.remove(1);
    expect(store.has(1)).toBe(false);
  });

  it('size() tracks correctly', () => {
    expect(store.size()).toBe(0);
    store.set(1, makeMeta());
    store.set(2, makeMeta());
    expect(store.size()).toBe(2);
  });
});

describe('LoadTracker', () => {
  let tracker: LoadTracker;

  beforeEach(() => { tracker = new LoadTracker(); });

  it('stores and retrieves entry', () => {
    const entry = { timestamp: Date.now(), effectiveGasPrice: '1000000000', providerName: 'mock' };
    tracker.add(1, entry);
    expect(tracker.has(1)).toBe(true);
    expect(tracker.get(1)).toEqual(entry);
  });

  it('effectiveGasPrice stored as string (no BigInt serialization issue)', () => {
    tracker.add(1, { timestamp: Date.now(), effectiveGasPrice: '99999999999999999' });
    const entry = tracker.get(1)!;
    expect(typeof entry.effectiveGasPrice).toBe('string');
    expect(entry.effectiveGasPrice).toBe('99999999999999999');
  });

  it('remove() works', () => {
    tracker.add(1, { timestamp: 1, effectiveGasPrice: '0' });
    tracker.remove(1);
    expect(tracker.has(1)).toBe(false);
  });

  it('count() tracks correctly', () => {
    expect(tracker.count()).toBe(0);
    tracker.add(1, { timestamp: 1, effectiveGasPrice: '0' });
    tracker.add(2, { timestamp: 2, effectiveGasPrice: '0' });
    expect(tracker.count()).toBe(2);
  });
});

describe('NonceIndex (EVM-specific)', () => {
  let idx: NonceIndex;
  const from1 = '0x' + 'a'.repeat(40);
  const from2 = '0x' + 'b'.repeat(40);

  beforeEach(() => { idx = new NonceIndex(); });

  it('stores and retrieves by (from, nonce)', () => {
    idx.set(from1, 5, 100);
    expect(idx.get(from1, 5)).toBe(100);
    expect(idx.get(from1, 6)).toBeUndefined();
    expect(idx.get(from2, 5)).toBeUndefined();
  });

  it('key is case-insensitive for from address', () => {
    const fromUpper = from1.toUpperCase();
    idx.set(fromUpper, 1, 42);
    // should find via lowercase version too
    expect(idx.get(from1.toLowerCase(), 1)).toBe(42);
  });

  it('remove() clears entry', () => {
    idx.set(from1, 5, 100);
    idx.remove(from1, 5);
    expect(idx.get(from1, 5)).toBeUndefined();
  });

  it('removeById() finds and removes by value', () => {
    idx.set(from1, 5, 777);
    idx.set(from1, 6, 888);
    idx.removeById(777);
    expect(idx.get(from1, 5)).toBeUndefined();
    expect(idx.get(from1, 6)).toBe(888);
  });

  it('different (from, nonce) pairs are independent', () => {
    idx.set(from1, 1, 10);
    idx.set(from1, 2, 20);
    idx.set(from2, 1, 30);
    expect(idx.get(from1, 1)).toBe(10);
    expect(idx.get(from1, 2)).toBe(20);
    expect(idx.get(from2, 1)).toBe(30);
  });
});

describe('ProviderTxMap', () => {
  let map: ProviderTxMap;

  beforeEach(() => { map = new ProviderTxMap(); });

  it('add() and get() work correctly', () => {
    map.add('provider-a', 1);
    map.add('provider-a', 2);
    map.add('provider-b', 3);
    expect(map.get('provider-a')?.has(1)).toBe(true);
    expect(map.get('provider-a')?.has(2)).toBe(true);
    expect(map.get('provider-b')?.has(3)).toBe(true);
  });

  it('remove() removes specific id from specific provider', () => {
    map.add('p', 1);
    map.add('p', 2);
    map.remove('p', 1);
    expect(map.get('p')?.has(1)).toBe(false);
    expect(map.get('p')?.has(2)).toBe(true);
  });

  it('removeId() removes id from all providers', () => {
    map.add('p1', 5);
    map.add('p2', 5);
    map.removeId(5);
    expect(map.get('p1')?.has(5)).toBe(false);
    expect(map.get('p2')?.has(5)).toBe(false);
  });

  it('providers() lists all provider names', () => {
    map.add('alpha', 1);
    map.add('beta', 2);
    expect(map.providers()).toContain('alpha');
    expect(map.providers()).toContain('beta');
  });
});

describe('BatchSizer', () => {
  it('returns default size for unknown provider', () => {
    const sizer = new BatchSizer(100, 10, 1000);
    expect(sizer.get('new-provider')).toBe(100);
  });

  it('shrinks when ratio > 1.2', () => {
    const sizer = new BatchSizer(100, 10, 1000);
    sizer.tune('p', 1.3);
    expect(sizer.get('p')).toBeLessThan(100);
  });

  it('grows when ratio < 0.8', () => {
    const sizer = new BatchSizer(100, 10, 1000);
    sizer.tune('p', 0.7);
    expect(sizer.get('p')).toBeGreaterThan(100);
  });

  it('stays stable when ratio is between 0.8 and 1.2', () => {
    const sizer = new BatchSizer(100, 10, 1000);
    sizer.tune('p', 1.0);
    expect(sizer.get('p')).toBe(100);
  });

  it('does not exceed maxSize', () => {
    const sizer = new BatchSizer(990, 10, 1000);
    sizer.tune('p', 0.1); // extreme grow
    expect(sizer.get('p')).toBeLessThanOrEqual(1000);
  });

  it('does not go below minSize', () => {
    const sizer = new BatchSizer(12, 10, 1000);
    sizer.tune('p', 10.0); // extreme shrink
    expect(sizer.get('p')).toBeGreaterThanOrEqual(10);
  });

  it('clear() resets all sizes', () => {
    const sizer = new BatchSizer(100, 10, 1000);
    sizer.tune('p', 0.5);
    sizer.clear();
    expect(sizer.get('p')).toBe(100);
  });
});
