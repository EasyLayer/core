import { BlockSizeCalculator as BSC } from '../block-size-calculator';

const netSegwit = {
  network: 'testnet',
  nativeCurrencySymbol: 'tBTC',
  nativeCurrencyDecimals: 8,
  hasSegWit: true,
  hasTaproot: true,
  hasRBF: true,
  hasCSV: true,
  hasCLTV: true,
  maxBlockSize: 1_000_000,
  maxBlockWeight: 4_000_000,
  difficultyAdjustmentInterval: 2016,
  targetBlockTime: 600,
} as any;

const netLegacy = { ...netSegwit, hasSegWit: false, hasTaproot: false } as any;

function mkTxStub({ ins, outs, scriptLenIn = 1, scriptLenOut = 1, byteLength }: { ins: number; outs: number; scriptLenIn?: number; scriptLenOut?: number; byteLength: number; }) {
  const tx: any = {
    ins: Array.from({ length: ins }, () => ({ script: Buffer.alloc(scriptLenIn) })),
    outs: Array.from({ length: outs }, () => ({ script: Buffer.alloc(scriptLenOut) })),
    byteLength: () => byteLength,
  };
  return tx;
}

describe('BlockSizeCalculator', () => {
  it('calculateTransactionSizeFromBitcoinJS segwit and legacy formulas', () => {
    const base = 4 + 1 + (32 + 4 + 1 + 5 + 4) + 1 + (8 + 1 + 7) + 4;
    const size = base + 50;
    const tx = mkTxStub({ ins: 1, outs: 1, scriptLenIn: 5, scriptLenOut: 7, byteLength: size });
    const seg = BSC.calculateTransactionSizeFromBitcoinJS(tx as any, netSegwit);
    expect(seg.strippedSize).toBe(base);
    expect(seg.witnessSize).toBe(size - base);
    expect(seg.weight).toBe(base * 4 + (size - base));
    expect(seg.vsize).toBe(Math.ceil(seg.weight / 4));

    const legacy = BSC.calculateTransactionSizeFromBitcoinJS(tx as any, netLegacy);
    expect(legacy.strippedSize).toBe(base);
    expect(legacy.witnessSize).toBeUndefined();
    expect(legacy.weight).toBe(base * 4);
    expect(legacy.vsize).toBe(base);
  });

  it('calculateTransactionSize from UniversalTransaction without hex', () => {
    const utx: any = { size: 200, vsize: 180, weight: 720 };
    const seg = BSC.calculateTransactionSize(utx, netSegwit);
    expect(seg.strippedSize).toBeLessThanOrEqual(utx.size);
    expect(seg.vsize).toBe(utx.vsize);
    expect(seg.weight).toBe(utx.weight);

    const leg = BSC.calculateTransactionSize(utx, netLegacy);
    expect(leg.strippedSize).toBe(utx.size);
    expect(leg.witnessSize).toBeUndefined();
  });

  it('calculateSizeFromTransactions with mix of ids and objects', () => {
    const utx: any = { size: 300, vsize: 250, weight: 1000, strippedsize: 250 };
    const res = BSC.calculateSizeFromBlock(
      { hash: 'h', strippedsize: 0, size: 0, weight: 0, version: 1, versionHex: '0x1', merkleroot: '', time: 0, mediantime: 0, nonce: 0, bits: '0x', difficulty: '0', chainwork: '', tx: ['id1', utx] } as any,
      netSegwit
    );
    expect(res.size).toBeGreaterThan(0);
    expect(res.strippedSize).toBeGreaterThan(0);
    expect(res.weight).toBeGreaterThan(0);
    expect(res.vsize).toBe(Math.ceil(res.weight / 4));
  });

  it('calculateSizeFromBlock fallback to given fields', () => {
    const res = BSC.calculateSizeFromBlock(
      { hash: 'h', strippedsize: 100, size: 120, weight: 420, version: 1, versionHex: '0x1', merkleroot: '', time: 0, mediantime: 0, nonce: 0, bits: '0x', difficulty: '0', chainwork: '' } as any,
      netSegwit
    );
    expect(res.size).toBe(120);
    expect(res.strippedSize).toBe(100);
    expect(res.witnessSize).toBe(20);
    expect(res.transactionsSize).toBe(40);
  });

  it('calculateBlockEfficiency and validateSizes', () => {
    const res = { size: 500_000, strippedSize: 400_000, weight: 2_100_000, vsize: Math.ceil(2_100_000 / 4), witnessSize: 100_000, headerSize: 80, transactionsSize: 499_920 };
    const eff = BSC.calculateBlockEfficiency(res as any, netSegwit);
    expect(eff.sizeEfficiency).toBeCloseTo(50);
    expect(eff.weightEfficiency).toBeCloseTo(52.5);
    expect(eff.witnessDataRatio).toBeCloseTo(20);

    expect(BSC.validateSizes(res as any)).toBe(true);
    const bad = { ...res, strippedSize: 600_000 };
    expect(BSC.validateSizes(bad as any)).toBe(false);
  });
});
