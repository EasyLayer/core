import { UniversalTransformer } from '../universal-transformer';

const segwitNet = {
  nativeCurrencyDecimals: 8,
  hasSegWit: true,
} as any;

const nonSegwitNet = {
  nativeCurrencyDecimals: 8,
  hasSegWit: false,
} as any;

describe('UniversalTransformer – RPC tx', () => {
  it('derives vsize from weight, strippedsize from size/weight, witnessSize only on segwit', () => {
    const raw = { txid: 'x', size: 200, weight: 760, locktime: 0, vin: [], vout: [] };
    const tx = UniversalTransformer.normalizeRpcTransaction(raw, segwitNet);
    expect(tx.vsize).toBe(190);
    expect(tx.strippedsize).toBe(Math.round((760 - 200) / 3));
    expect(tx.witnessSize).toBe(200 - (tx.strippedsize as number));
  });

  it('non-segwit keeps strippedsize from size or weight and no witnessSize', () => {
    const raw = { txid: 'y', weight: 600, locktime: 0, vin: [], vout: [] };
    const tx = UniversalTransformer.normalizeRpcTransaction(raw, nonSegwitNet);
    expect(tx.vsize).toBe(150);
    expect(tx.strippedsize).toBe(150);
    expect(tx.witnessSize).toBeUndefined();
  });
});

describe('UniversalTransformer – RPC block', () => {
  it('normalizes block with object tx list and computes vsize from weight', () => {
    const rawTx = { txid: 't1', size: 190, weight: 760, locktime: 0, vin: [], vout: [] };
    const raw = {
      hash: 'h',
      height: 1,
      strippedsize: 1000,
      size: 1200,
      weight: 4800,
      version: 2,
      versionHex: '0x2',
      merkleroot: 'm',
      time: 10,
      nonce: 1,
      bits: '0x',
      difficulty: '1',
      previousblockhash: 'p',
      tx: [rawTx],
      nTx: 1,
    };
    const b = UniversalTransformer.normalizeRpcBlock(raw, segwitNet)!;
    expect(b.vsize).toBe(1200);
    expect(Array.isArray(b.tx)).toBe(true);
    const t = (b.tx as any[])[0];
    expect(t.vsize).toBe(190);
    expect(t.strippedsize).toBe(Math.round((760 - 190) / 3)); // weight present but size missing in tx → base from size/weight when both; here size present
  });

  it('passes through string txids and returns null on falsy', () => {
    const raw = { hash: 'h', tx: ['a', 'b'] };
    const b = UniversalTransformer.normalizeRpcBlock(raw as any, segwitNet)!;
    expect(b.tx).toEqual(['a', 'b']);
    expect(UniversalTransformer.normalizeRpcBlock(null as any, segwitNet)).toBeNull();
  });
});

describe('UniversalTransformer – RPC block stats', () => {
  it('maps fields and returns null on falsy', () => {
    const raw = { blockhash: 'h', height: 2, total_size: 100, total_weight: 400, txs: 3 };
    const s = UniversalTransformer.normalizeRpcBlockStats(raw as any)!;
    expect(s.blockhash).toBe('h');
    expect(s.height).toBe(2);
    expect(s.total_size).toBe(100);
    expect(s.total_weight).toBe(400);
    expect(UniversalTransformer.normalizeRpcBlockStats(undefined as any)).toBeNull();
  });
});

describe('UniversalTransformer – mempool info', () => {
  it('converts coin and per-kvB to sats and sat/vB', () => {
    const raw = {
      loaded: true,
      size: 10,
      bytes: 1000,
      usage: 2000,
      total_fee: 0.00012345,
      maxmempool: 300000000,
      mempoolminfee: 0.001,
      minrelaytxfee: 0.002,
      unbroadcastcount: 5,
      incrementalrelayfee: 0.0005,
      fullrbf: true,
    };
    const m = UniversalTransformer.normalizeRpcMempoolInfo(raw, segwitNet);
    expect(m.loaded).toBe(true);
    expect(m.total_fee).toBe(12345);
    expect(m.mempoolminfee).toBe(100);
    expect(m.minrelaytxfee).toBe(200);
    expect(m.incrementalrelayfee).toBe(50);
  });
});

describe('UniversalTransformer – mempool entry', () => {
  it('converts fees to sats and maps flags', () => {
    const raw = {
      vsize: 200,
      weight: 800,
      time: 10,
      height: 1,
      depends: ['a'],
      spentby: ['b'],
      descendantcount: 2,
      descendantsize: 300,
      ancestorcount: 1,
      ancestorsize: 150,
      fees: { base: 0.0002, modified: 0.00021, ancestor: 0.0004, descendant: 0.0003 },
      'bip125-replaceable': true,
      unbroadcast: false,
    };
    const e = UniversalTransformer.normalizeRpcMempoolEntry(raw as any, segwitNet, 'txid1');
    expect(e.txid).toBe('txid1');
    expect(e.fees.base).toBe(20000);
    expect(e.fees.modified).toBe(21000);
    expect(e.fees.ancestor).toBe(40000);
    expect(e.fees.descendant).toBe(30000);
    expect(e.bip125_replaceable).toBe(true);
    expect(e.unbroadcast).toBe(false);
  });
});

describe('UniversalTransformer – smart fee', () => {
  it('converts coin/kB to sat/vB', () => {
    const raw = { feerate: 0.00015, blocks: 3, errors: [] };
    const f = UniversalTransformer.normalizeRpcSmartFee(raw as any, segwitNet);
    expect(f.sat_per_vb).toBe(15);
    expect(f.blocks).toBe(3);
  });
});

describe('UniversalTransformer – bytes guards', () => {
  it('parseTxBytes throws on empty bytes', () => {
    expect(() => UniversalTransformer.parseTxBytes(new Uint8Array(), segwitNet)).toThrow(/Transaction bytes are required/i);
  });

  it('parseBlockBytes throws on empty bytes', () => {
    expect(() => UniversalTransformer.parseBlockBytes(new Uint8Array(), 1 as any, segwitNet)).toThrow(/Block bytes are required/i);
  });
});
