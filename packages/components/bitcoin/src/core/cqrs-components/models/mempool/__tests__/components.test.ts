import {
  hashTxid32,
  TxIndex,
  MetadataStore,
  TxStore,
  ProviderTxMap,
  LoadTracker,
  BatchSizer,
} from '../components';

describe('hashTxid32', () => {
  it('is deterministic and within uint32 range', () => {
    const txid = 'a'.repeat(64);
    const h1 = hashTxid32(txid);
    const h2 = hashTxid32(txid);
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it('differs for different strings', () => {
    const h1 = hashTxid32('0'.repeat(64));
    const h2 = hashTxid32('1'.repeat(64));
    expect(h1).not.toBe(h2);
  });
});

describe('TxIndex', () => {
  it('adds and retrieves both ways', () => {
    const idx = new TxIndex();
    const txid = 'f'.repeat(64);
    const h = idx.add(txid);
    expect(idx.hasHash(h)).toBe(true);
    expect(idx.hasTxid(txid)).toBe(true);
    expect(idx.getByHash(h)).toBe(txid);
    expect(idx.getByTxid(txid)).toBe(h);
    expect(idx.size()).toBe(1);
  });

  it('removes by hash and clears maps', () => {
    const idx = new TxIndex();
    const h = idx.add('a'.repeat(64));
    idx.removeByHash(h);
    expect(idx.hasHash(h)).toBe(false);
    expect(idx.size()).toBe(0);
    idx.add('b'.repeat(64));
    idx.clear();
    expect(idx.size()).toBe(0);
  });

  it('snapshot map setters/getters work', () => {
    const idx = new TxIndex();
    const m = new Map<number, string>();
    m.set(123, 'x'.repeat(64));
    idx.__setMap(m);
    expect(idx.size()).toBe(1);
    expect(idx.__getMap()).toBe(m);
    expect(idx.getByHash(123)).toBe('x'.repeat(64));
  });
});

describe('MetadataStore', () => {
  const sampleMeta = (overrides: Partial<any> = {}): any => ({
    txid: 't'.repeat(64),
    size: 100,
    vsize: 100,
    weight: 400,
    fee: 5000,
    modifiedfee: 5000,
    time: 1,
    height: 0,
    depends: [],
    descendantcount: 0,
    descendantsize: 0,
    descendantfees: 0,
    ancestorcount: 0,
    ancestorsize: 0,
    ancestorfees: 0,
    fees: { base: 5000, modified: 5000, ancestor: 0, descendant: 0 },
    bip125_replaceable: false,
    ...overrides,
  });

  it('set/get/has/remove/size/clear', () => {
    const ms = new MetadataStore();
    const meta = sampleMeta();
    ms.set(1, meta);
    expect(ms.get(1)).toEqual(meta);
    expect(ms.has(1)).toBe(true);
    expect(ms.size()).toBe(1);
    const entries = Array.from(ms.entries());
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual([1, meta]);
    ms.remove(1);
    expect(ms.has(1)).toBe(false);
    expect(ms.size()).toBe(0);
    ms.set(2, sampleMeta({ fee: 123 }));
    ms.clear();
    expect(ms.size()).toBe(0);
  });

  it('snapshot accessors work', () => {
    const ms = new MetadataStore();
    const m = new Map<number, any>([[7, sampleMeta({ fee: 1 })]]);
    ms.__setMap(m);
    expect(ms.__getMap()).toBe(m);
    expect(ms.get(7)).toEqual(m.get(7));
  });
});

describe('TxStore', () => {
  const slimTx = (id: string): any => ({
    txid: id,
    hash: id,
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

  it('set/get/has/remove/clear/size', () => {
    const st = new TxStore();
    st.set(5, slimTx('a'));
    expect(st.get(5)?.txid).toBe('a');
    expect(st.has(5)).toBe(true);
    expect(st.size()).toBe(1);
    st.remove(5);
    expect(st.get(5)).toBeUndefined();
    expect(st.size()).toBe(0);
    st.set(1, slimTx('x'));
    st.set(2, slimTx('y'));
    st.clear();
    expect(st.size()).toBe(0);
  });

  it('snapshot accessors work', () => {
    const st = new TxStore();
    const m = new Map<number, any>([[9, slimTx('z')]]);
    st.__setMap(m);
    expect(st.__getMap()).toBe(m);
    expect(st.get(9)?.txid).toBe('z');
  });
});

describe('ProviderTxMap', () => {
  it('adds tx hashes per provider and reads them back', () => {
    const pm = new ProviderTxMap();
    pm.add('A', 10);
    pm.add('A', 11);
    pm.add('B', 20);
    const setA = pm.get('A')!;
    const setB = pm.get('B')!;
    expect(setA.has(10)).toBe(true);
    expect(setA.has(11)).toBe(true);
    expect(setB.has(20)).toBe(true);
    expect(pm.providers().sort()).toEqual(['A', 'B']);
  });

  it('clear removes all provider mappings', () => {
    const pm = new ProviderTxMap();
    pm.add('A', 1);
    expect(pm.get('A')!.size).toBe(1);
    pm.clear();
    expect(pm.get('A')).toBeUndefined();
    expect(pm.providers().length).toBe(0);
  });

  it('snapshot accessors work', () => {
    const pm = new ProviderTxMap();
    const map = new Map<string, Set<number>>([['X', new Set([1,2,3])]]);
    pm.__setMap(map);
    expect(pm.__getMap()).toBe(map);
    expect(pm.get('X')!.has(2)).toBe(true);
  });
});

describe('LoadTracker', () => {
  it('add/has/get/remove/clear/count', () => {
    const lt = new LoadTracker();
    const info = { timestamp: 123, feeRate: 5.5, providerName: 'A' };
    lt.add(77, info);
    expect(lt.has(77)).toBe(true);
    expect(lt.get(77)).toEqual(info);
    expect(lt.count()).toBe(1);
    lt.remove(77);
    expect(lt.has(77)).toBe(false);
    expect(lt.count()).toBe(0);
    lt.add(1, info);
    lt.clear();
    expect(lt.count()).toBe(0);
  });

  it('snapshot accessors work', () => {
    const lt = new LoadTracker();
    const m = new Map<number, any>([[5, { timestamp: 1, feeRate: 1, providerName: 'P' }]]);
    lt.__setMap(m);
    expect(lt.__getMap()).toBe(m);
    expect(lt.get(5)?.providerName).toBe('P');
  });
});

describe('BatchSizer', () => {
  it('returns default and tunes up/down', () => {
    const bs = new BatchSizer(100, 10, 1000);
    expect(bs.get('A')).toBe(100);
    bs.tune('A', 0.7);
    expect(bs.get('A')).toBeGreaterThan(100);
    bs.tune('A', 1.5);
    expect(bs.get('A')).toBeLessThanOrEqual( Math.round((Math.round(100*1.2))*0.8) );
  });

  it('clamps to min/max and clears', () => {
    const bs = new BatchSizer(50, 20, 60);
    bs.tune('A', 0.1);
    expect(bs.get('A')).toBeLessThanOrEqual(60);
    bs.tune('A', 10);
    expect(bs.get('A')).toBeGreaterThanOrEqual(20);
    bs.clear();
    expect(bs.get('A')).toBe(50);
  });
});
