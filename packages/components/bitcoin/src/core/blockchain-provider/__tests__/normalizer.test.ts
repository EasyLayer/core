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

describe('BitcoinNormalizer', () => {
  it('normalizeBlock throws when height is missing', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      strippedsize: 180,
      size: 200,
      weight: 720,
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
    expect(() => normalizer.normalizeBlock(universalBlock)).toThrow(/Block height is required/);
  });

  it('normalizeBlock computes vsize, witnessSize, transactionsSize and efficiency, filters string transactions', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const txObject: any = {
      txid: 't'.repeat(64),
      hash: 't'.repeat(64),
      version: 2,
      size: 190,
      vsize: 180,
      weight: 720,
      locktime: 0,
      vin: [{ txid: 'p'.repeat(64), vout: 0, scriptSig: { asm: '', hex: '' }, sequence: 0 }],
      vout: [{ value: 1.23, n: 0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' } }],
      wtxid: 'w'.repeat(64),
      time: 10,
      blocktime: 10,
    };
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      height: 100,
      strippedsize: 180,
      size: 200,
      weight: 720,
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
      tx: ['dead', txObject],
      nTx: 2,
      fee: 123,
      subsidy: 50,
      miner: 'm',
      pool: { poolName: 'p', url: 'u' },
    };
    const copyBefore = JSON.parse(JSON.stringify(universalBlock));
    const out = normalizer.normalizeBlock(universalBlock);
    expect(out.vsize).toBe(Math.ceil(universalBlock.weight / 4));
    expect(out.witnessSize).toBe(universalBlock.size - universalBlock.strippedsize);
    expect(out.transactionsSize).toBe(universalBlock.size - 80);
    expect(out.blockSizeEfficiency).toBeCloseTo((universalBlock.size / (makeSegwitNetwork().maxBlockSize)) * 100, 6);
    expect(out.witnessDataRatio).toBeCloseTo(((universalBlock.size - universalBlock.strippedsize) / universalBlock.size) * 100, 6);
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

  it('normalizeTransaction computes strippedsize and witnessSize on SegWit network and feeRate', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalTx: any = {
      txid: 't'.repeat(64),
      hash: 't'.repeat(64),
      version: 2,
      size: 200,
      vsize: 190,
      weight: 760,
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
    const expectedBase = Math.floor((universalTx.weight + 3) / 4);
    expect(out.strippedsize).toBe(Math.min(expectedBase, universalTx.size));
    expect(out.witnessSize).toBe(universalTx.size - out.strippedsize);
    expect(out.feeRate).toBe(Math.round(universalTx.fee / universalTx.vsize));
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
      locktime: 0,
      vin: [{ txid: 'p'.repeat(64), vout: 1, scriptSig: { asm: '', hex: '' }, sequence: 0 }],
      vout: [{ value: 2.5, n: 0, scriptPubKey: { asm: '', hex: '', type: 'pubkeyhash' } }],
      fee: 500,
    };
    const out = normalizer.normalizeTransaction(universalTx);
    expect(out.strippedsize).toBe(universalTx.size);
    expect(out.witnessSize).toBeUndefined();
    expect(out.feeRate).toBe(Math.round((universalTx.fee ?? 0) / universalTx.vsize));
  });

  it('normalizeManyBlocks and normalizeManyTransactions map arrays and preserve order', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const blocks: any[] = [
      { hash: 'a1', height: 1, strippedsize: 10, size: 20, weight: 80, version: 1, versionHex: '0x1', merkleroot: '', time: 1, mediantime: 1, nonce: 1, bits: '0x', difficulty: '1', chainwork: '' },
      { hash: 'a2', height: 2, strippedsize: 12, size: 22, weight: 88, version: 1, versionHex: '0x1', merkleroot: '', time: 1, mediantime: 1, nonce: 1, bits: '0x', difficulty: '1', chainwork: '' },
    ];
    const txs: any[] = [
      { txid: 't1', hash: 't1', version: 1, size: 10, vsize: 10, weight: 40, locktime: 0, vin: [], vout: [] },
      { txid: 't2', hash: 't2', version: 1, size: 20, vsize: 20, weight: 80, locktime: 0, vin: [], vout: [] },
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

  it('normalizeBlockStats computes total_witness_size, total_vsize and witness_ratio when data is present', () => {
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
    expect(out.witness_ratio).toBeCloseTo(50);
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

  it('normalizeBlock sets undefined fields when universal data is missing', () => {
    const normalizer = new BitcoinNormalizer(makeSegwitNetwork() as any);
    const universalBlock: any = {
      hash: 'aa'.repeat(32),
      height: 7,
      strippedsize: 0,
      size: 0,
      weight: 0,
      version: 1,
      versionHex: '0x00000001',
      merkleroot: '11'.repeat(32),
      time: 1,
      mediantime: 1,
      nonce: 1,
      bits: '0x1d00ffff',
      difficulty: '1',
      chainwork: '',
    };
    const out = normalizer.normalizeBlock(universalBlock);
    expect(out.tx).toBeUndefined();
    expect(out.vsize).toBe(0);
    expect(out.witnessSize).toBeUndefined();
    expect(out.transactionsSize).toBe(0);
    expect(out.blockSizeEfficiency).toBe(0);
    expect(out.witnessDataRatio).toBeUndefined();
  });
});
