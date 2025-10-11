import {
  hashTxid32,
  TxIndex,
  ProviderMap,
  MetadataStore,
  TxStore,
  LoadTracker,
} from '../components';

describe('hashTxid32', () => {
  it('returns deterministic uint32 for same string', () => {
    const txid = 'a'.repeat(64);
    const h1 = hashTxid32(txid);
    const h2 = hashTxid32(txid);
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it('likely differs for different strings', () => {
    const h1 = hashTxid32('0'.repeat(64));
    const h2 = hashTxid32('1'.repeat(64));
    expect(h1).not.toBe(h2);
  });
});

describe('TxIndex', () => {
  it('adds and retrieves txid by hash', () => {
    const idx = new TxIndex();
    const txid = 'f'.repeat(64);
    const h = idx.add(txid);
    expect(idx.hasHash(h)).toBe(true);
    expect(idx.getByHash(h)).toBe(txid);
    expect([...idx.values()]).toContain(txid);
    expect([...idx.keys()]).toContain(h);
    expect(idx.size()).toBe(1);
  });

  it('removes by hash and clears', () => {
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
  });
});

describe('ProviderMap', () => {
  it('sets fixed names once and resolves indices by name', () => {
    const pm = new ProviderMap();
    pm.setNamesOnce(['A', 'B', 'C']);
    expect(pm.getProviderNames()).toEqual(['A', 'B', 'C']);
    expect(pm.getProviderName(0)).toBe('A');
    expect(pm.getProviderName(1)).toBe('B');
    expect(pm.getProviderName(2)).toBe('C');
    expect(pm.getIndexByName('A')).toBe(0);
    expect(pm.getIndexByName('B')).toBe(1);
    expect(pm.getIndexByName('C')).toBe(2);
    expect(pm.getIndexByName('Z')).toBeUndefined();
    expect([...pm.providerIndices()]).toEqual([0, 1, 2]);
  });

  it('maps tx to exact provider set and replaces on setProvidersForTx', () => {
    const pm = new ProviderMap();
    pm.setNamesOnce(['A', 'B', 'C']);
    const h = 111;
    pm.setProvidersForTx(h, [0]);
    let set = pm.getProviders(h)!;
    expect(set.size).toBe(1);
    expect(set.has(0)).toBe(true);

    pm.setProvidersForTx(h, [1, 2]);
    set = pm.getProviders(h)!;
    expect(set.size).toBe(2);
    expect(set.has(1)).toBe(true);
    expect(set.has(2)).toBe(true);
    expect(set.has(0)).toBe(false);
  });

  it('removes mapping and clear keeps names', () => {
    const pm = new ProviderMap();
    pm.setNamesOnce(['A', 'B']);
    const h = 222;
    pm.setProvidersForTx(h, [1]);
    expect(pm.getProviders(h)!.has(1)).toBe(true);
    pm.remove(h);
    expect(pm.getProviders(h)).toBeUndefined();
    pm.clear();
    expect(pm.getProviderNames()).toEqual(['A', 'B']);
  });

  it('snapshot accessors work', () => {
    const pm = new ProviderMap();
    const map = new Map<number, Set<number>>([[10, new Set([0, 1])]]);
    pm.__setMap(map);
    pm.__setNames(['X', 'Y']);
    expect(pm.__getMap()).toBe(map);
    expect(pm.__getNames()).toEqual(['X', 'Y']);
    expect(pm.getProviderName(1)).toBe('Y');
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
    fee: 1000,
    feeRate: 10,
    wtxid: id,
    bip125_replaceable: false,
  });

  it('put/get/remove/count/clear', () => {
    const st = new TxStore();
    st.put(5, slimTx('a'));
    expect(st.get(5)?.txid).toBe('a');
    expect(st.count()).toBe(1);
    st.remove(5);
    expect(st.get(5)).toBeUndefined();
    expect(st.count()).toBe(0);
    st.put(1, slimTx('x'));
    st.put(2, slimTx('y'));
    st.clear();
    expect(st.count()).toBe(0);
  });

  it('snapshot accessors work', () => {
    const st = new TxStore();
    const m = new Map<number, any>([[9, slimTx('z')]]);
    st.__setMap(m);
    expect(st.__getMap()).toBe(m);
    expect(st.get(9)?.txid).toBe('z');
  });
});

describe('LoadTracker', () => {
  it('marks, queries, removes, clears', () => {
    const lt = new LoadTracker();
    const info = { timestamp: 123, feeRate: 5.5, providerIndex: 0 };
    lt.mark(77, info);
    expect(lt.isLoaded(77)).toBe(true);
    expect(lt.get(77)).toEqual(info);
    expect(lt.count()).toBe(1);
    lt.remove(77);
    expect(lt.isLoaded(77)).toBe(false);
    expect(lt.count()).toBe(0);
    lt.mark(1, info);
    lt.clear();
    expect(lt.count()).toBe(0);
  });

  it('snapshot accessors work', () => {
    const lt = new LoadTracker();
    const m = new Map<number, any>([[5, { timestamp: 1, feeRate: 1, providerIndex: 2 }]]);
    lt.__setMap(m);
    expect(lt.__getMap()).toBe(m);
    expect(lt.get(5)?.providerIndex).toBe(2);
  });
});
