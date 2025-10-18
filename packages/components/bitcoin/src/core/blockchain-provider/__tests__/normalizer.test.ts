import { BitcoinNormalizer } from '../normalizer';

function makeSegwitNetwork() {
  return {
    network: 'testnet',
    nativeCurrencySymbol: 'tBTC',
    nativeCurrencyDecimals: 8,
    magicBytes: 0x0b110907,
    defaultPort: 18333,
    hasSegWit: true,
    hasTaproot: true,
    hasRBF: true,
    hasCSV: true,
    hasCLTV: true,
    maxBlockSize: 1_000_000,
    maxBlockWeight: 4_000_000,
    difficultyAdjustmentInterval: 2016,
    targetBlockTime: 600,
  } as const;
}

function makeNonSegwitNetwork() {
  return {
    network: 'testnet',
    nativeCurrencySymbol: 'tBTC',
    nativeCurrencyDecimals: 8,
    magicBytes: 0x0b110907,
    defaultPort: 18333,
    hasSegWit: false,
    hasTaproot: false,
    hasRBF: true,
    hasCSV: true,
    hasCLTV: true,
    maxBlockSize: 1_000_000,
    maxBlockWeight: 4_000_000,
    difficultyAdjustmentInterval: 2016,
    targetBlockTime: 600,
  } as const;
}

function varintSize(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

describe('BitcoinNormalizer', () => {
  it('normalizeBlock throws when height is missing', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      strippedsize: 180,
      size: 200,
      weight: 720,
      vsize: Math.ceil(720 / 4),
      version: 1,
      versionHex: '0x00000001',
      merkleroot: '11'.repeat(32),
      time: 1,
      mediantime: 1,
      nonce: 1,
      bits: '0x1d00ffff',
      difficulty: '1',
      chainwork: '',
      previousblockhash: '22'.repeat(32),
      nextblockhash: undefined,
      tx: [],
      nTx: 0,
    };
    expect(() => normalizer.normalizeBlock(universalBlock)).toThrow(/block\.height/i);
  });

  it('normalizeBlock computes metrics and maps tx objects', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const txObject: any = {
      txid: 't'.repeat(64),
      hash: 't'.repeat(64),
      version: 2,
      size: 190,
      vsize: 180,
      weight: 720,
      strippedsize: 170,
      locktime: 0,
      vin: [{ txid: 'p'.repeat(64), vout: 0, scriptSig: { asm: '', hex: '' }, sequence: 0 }],
      vout: [{ value: 1.23, n: 0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' } }],
      wtxid: 'w'.repeat(64),
      time: 10,
      blocktime: 10,
      fee: 1800,
      witnessSize: 20,
    };
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      height: 100,
      strippedsize: 180,
      size: 200,
      weight: 720,
      vsize: Math.ceil(720 / 4),
      version: 1,
      versionHex: '0x00000001',
      merkleroot: '11'.repeat(32),
      time: 1,
      mediantime: 1,
      nonce: 1,
      bits: '0x1d00ffff',
      difficulty: '1',
      chainwork: '',
      previousblockhash: '22'.repeat(32),
      nextblockhash: undefined,
      tx: [txObject],
      nTx: 1,
      fee: 123,
      subsidy: 50,
      miner: 'm',
      pool: { poolName: 'p', url: 'u' },
    };
    const copyBefore = JSON.parse(JSON.stringify(universalBlock));
    const out = normalizer.normalizeBlock(universalBlock);
    expect(out.vsize).toBe(universalBlock.vsize);
    expect(out.witnessSize).toBe(universalBlock.size - universalBlock.strippedsize);
    expect(out.transactionsSize).toBe(txObject.vsize);
    expect(out.blockSizeEfficiency).toBeCloseTo(universalBlock.size / makeSegwitNetwork().maxBlockSize, 10);
    expect(out.witnessDataRatio).toBeCloseTo((universalBlock.size - universalBlock.strippedsize) / universalBlock.size, 10);
    expect(out.tx?.length).toBe(1);
    expect(out.tx?.[0]?.txid).toBe(txObject.txid);
    expect(universalBlock).toEqual(copyBefore);
  });

  it('normalizeBlock on non-SegWit network produces undefined witnessSize and witnessDataRatio', () => {
    const normalizer = new BitcoinNormalizer(makeNonSegwitNetwork() as any);
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      height: 5,
      strippedsize: 180,
      size: 200,
      weight: 720,
      vsize: Math.ceil(720 / 4),
      version: 1,
      versionHex: '0x00000001',
      merkleroot: '11'.repeat(32),
      time: 1,
      mediantime: 1,
      nonce: 1,
      bits: '0x1d00ffff',
      difficulty: '1',
      chainwork: '',
      previousblockhash: '22'.repeat(32),
      nextblockhash: undefined,
      tx: [],
      nTx: 0,
    };
    const out = normalizer.normalizeBlock(universalBlock);
    expect(out.witnessSize).toBeUndefined();
    expect(out.witnessDataRatio).toBeUndefined();
  });

  it('normalizeTransaction computes fields on SegWit network and feeRate', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalTx: any = {
      txid: 't'.repeat(64),
      hash: 't'.repeat(64),
      version: 2,
      size: 200,
      vsize: 190,
      weight: 760,
      strippedsize: 190,
      witnessSize: 10,
      locktime: 0,
      vin: [{ txid: 'p'.repeat(64), vout: 0, scriptSig: { asm: '', hex: '' }, sequence: 0, txinwitness: ['aa'] }],
      vout: [{ value: 1.23, n: 0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' } }],
      blockhash: 'b'.repeat(64),
      time: 10,
      blocktime: 10,
      fee: 1000,
      wtxid: 'w'.repeat(64),
    };
    const out = normalizer.normalizeTransaction(universalTx);
    expect(out.strippedsize).toBe(190);
    expect(out.witnessSize).toBe(10);
    expect(out.feeRate!).toBeCloseTo(1000 / 190, 10);
    expect(out.vin[0]!.txinwitness).toEqual(['aa']);
  });

  it('normalizeTransaction on non-SegWit network keeps strippedsize equal to size and witnessSize undefined', () => {
    const normalizer = new BitcoinNormalizer(makeNonSegwitNetwork() as any);
    const universalTx: any = {
      txid: 't'.repeat(64),
      hash: 't'.repeat(64),
      version: 1,
      size: 150,
      vsize: 150,
      weight: 600,
      strippedsize: 150,
      locktime: 0,
      vin: [{ txid: 'p'.repeat(64), vout: 1, scriptSig: { asm: '', hex: '' }, sequence: 0 }],
      vout: [{ value: 2.5, n: 0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' } }],
      fee: 500,
    };
    const out = normalizer.normalizeTransaction(universalTx);
    expect(out.strippedsize).toBe(universalTx.size);
    expect(out.witnessSize).toBeUndefined();
    expect(out.feeRate!).toBeCloseTo((universalTx.fee ?? 0) / universalTx.vsize, 10);
  });

  it('normalizeManyBlocks and normalizeManyTransactions map arrays and preserve order', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const blocks: any[] = [
      { hash: 'a1', height: 1, strippedsize: 81, size: 81, weight: 324, vsize: 81, version: 1, versionHex: '0x1', merkleroot: 'mr1', time: 1, mediantime: 1, nonce: 1, bits: '0x', difficulty: '1', chainwork: '', nTx: 0, tx: [] },
      { hash: 'a2', height: 2, strippedsize: 83, size: 83, weight: 332, vsize: 83, version: 1, versionHex: '0x1', merkleroot: 'mr2', time: 1, mediantime: 1, nonce: 1, bits: '0x', difficulty: '1', chainwork: '', nTx: 0, tx: [] },
    ];
    const txs: any[] = [
      { txid: 't1', hash: 't1', version: 1, size: 10, vsize: 10, weight: 40, strippedsize: 10, locktime: 0, vin: [], vout: [] },
      { txid: 't2', hash: 't2', version: 1, size: 20, vsize: 20, weight: 80, strippedsize: 20, locktime: 0, vin: [], vout: [] },
    ];
    const nb = normalizer.normalizeManyBlocks(blocks as any);
    const nt = normalizer.normalizeManyTransactions(txs as any);
    expect(nb.length).toBe(2);
    expect(nb[0]!.hash).toBe('a1');
    expect(nb[1]!.hash).toBe('a2');
    expect(nt.length).toBe(2);
    expect(nt[0]!.txid).toBe('t1');
    expect(nt[1]!.txid).toBe('t2');
  });

  it('normalizeBlockStats computes total_witness_size and total_vsize and fractional witness_ratio', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const stats: any = {
      blockhash: 'h'.repeat(64),
      height: 10,
      total_size: 1000,
      total_stripped_size: 800,
      total_weight: 3600,
      total_fee: 1,
      fee_rate_percentiles: [1, 2, 3, 4, 5],
      subsidy: 50,
      total_out: 2,
      utxo_increase: 1,
      utxo_size_inc: 1,
      ins: 1,
      outs: 1,
      txs: 100,
      minfee: 1,
      maxfee: 2,
      medianfee: 1,
      avgfee: 1.5,
      minfeerate: 1,
      maxfeerate: 2,
      medianfeerate: 1,
      avgfeerate: 1.5,
      mintxsize: 1,
      maxtxsize: 2,
      mediantxsize: 1,
      avgtxsize: 1.5,
      witness_txs: 50,
    };
    const out = normalizer.normalizeBlockStats(stats);
    expect(out.total_witness_size).toBe(200);
    expect(out.total_vsize).toBe(Math.ceil((stats.total_weight ?? 0) / 4));
    expect(out.witness_ratio).toBeCloseTo(0.5, 10);
  });

  it('normalizeBlockStats leaves witness fields undefined when inputs are insufficient', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const stats: any = {
      blockhash: 'h'.repeat(64),
      height: 10,
      total_size: 500,
      total_weight: undefined,
      txs: 0,
      witness_txs: undefined,
    };
    const out = normalizer.normalizeBlockStats(stats);
    expect(out.total_witness_size).toBeUndefined();
    expect(out.total_vsize).toBeUndefined();
    expect(out.witness_ratio).toBeUndefined();
  });

  it('normalizeBlock sets minimal computable fields when many universals are missing', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      height: 7,
      strippedsize: 81,
      size: 81,
      weight: 324,
      vsize: 81,
      version: 1,
      versionHex: '0x00000001',
      merkleroot: '11'.repeat(32),
      time: 1,
      mediantime: 1,
      nonce: 1,
      bits: '0x1d00ffff',
      difficulty: '1',
      chainwork: '',
      tx: [],
      nTx: 0,
    };
    const out = normalizer.normalizeBlock(universalBlock);
    expect(out.tx).toEqual([]);
    expect(out.vsize).toBe(81);
    expect(out.witnessSize).toBe(0);
    expect(out.transactionsSize).toBe(0);
    expect(out.blockSizeEfficiency).toBeCloseTo(81 / makeSegwitNetwork().maxBlockSize, 10);
    expect(out.witnessDataRatio).toBe(0);
  });

  it('normalizeBlock uses size - 80 - varint(nTx) when only hashes are provided', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalBlock: any = {
      hash: 'bb'.repeat(32),
      height: 12,
      strippedsize: 1000,
      size: 1200,
      weight: 4800,
      vsize: Math.ceil(4800 / 4),
      version: 2,
      versionHex: '0x00000002',
      merkleroot: '22'.repeat(32),
      time: 2,
      mediantime: 2,
      nonce: 2,
      bits: '0x1d00ffff',
      difficulty: '2',
      chainwork: '',
      previousblockhash: '11'.repeat(32),
      tx: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
      nTx: 3,
    };
    const out = normalizer.normalizeBlock(universalBlock);
    const expected = universalBlock.size - 80 - varintSize(universalBlock.nTx);
    expect(out.transactionsSize).toBe(expected);
    expect(out.tx).toBeUndefined();
  });
});
