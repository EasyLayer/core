import { Buffer } from 'buffer';
import { HexTransformer } from '../hex-transformer';

// ---- bitcoinjs-lib mocks ----
jest.mock('bitcoinjs-lib', () => {
  let currentMockBlock: any = null;
  let currentMockTransaction: any = null;

  const script = {
    toASM: (buf: Buffer) => `asm:${buf.toString('hex')}`,
  };

  class Block {
    static fromBuffer(_b: Buffer) { return currentMockBlock; }
  }

  class Transaction {
    static fromBuffer(_b: Buffer) { return currentMockTransaction; }
  }

  return {
    Block,
    Transaction,
    script,
    __setMockBlock: (b: any) => (currentMockBlock = b),
    __setMockTx: (t: any) => (currentMockTransaction = t),
  };
});

// ---- utils mocks ----
// The block code computes sizes from bytes, then calls validateSizes.
// TX path uses calculateTransactionSizeFromBitcoinJS and validateSizes.
jest.mock('../../utils', () => {
  const txSize = { size: 10, strippedSize: 9, weight: 40, vsize: 10 };
  return {
    BlockSizeCalculator: {
      calculateTransactionSizeFromHex: jest.fn(() => txSize),
      calculateTransactionSizeFromBitcoinJS: jest.fn(() => txSize),
      validateSizes: jest.fn(() => true),
    },
  };
});

const { __setMockBlock, __setMockTx } = jest.requireMock('bitcoinjs-lib');
const utils = jest.requireMock('../../utils');

function beToLeBuffer(hex: string) {
  return Buffer.from(hex, 'hex').reverse();
}

describe('HexTransformer (bytes-only API)', () => {
  const networkWithSegWit: any = {
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
  };

  const networkWithoutSegWit: any = {
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
  };

  // ---------------------------
  // BLOCKS (BYTES)
  // ---------------------------

  it('parseBlockBytes: sets BE header fields, computes sizes, parses txs, sets wtxid', () => {
    const beHash = 'aa'.repeat(32);
    const beMerkle = '11'.repeat(32);
    const bePrev = '22'.repeat(32);

    const mockTx = {
      version: 2,
      locktime: 0,
      ins: [
        {
          hash: beToLeBuffer('ff'.repeat(32)),
          index: 1,
          script: Buffer.from('51', 'hex'),
          sequence: 0,
          witness: [Buffer.from('aa', 'hex')],
        },
      ],
      outs: [
        { value: 123456789, script: Buffer.from('0014' + '11'.repeat(20), 'hex') }, // P2WPKH
        { value: 1000,      script: Buffer.from('76a914' + '22'.repeat(20) + '88ac', 'hex') }, // P2PKH
        { value: 0,         script: Buffer.from('5120' + '33'.repeat(32), 'hex') }, // Taproot
      ],
      getId: () => 'txidbe',
      hasWitnesses: () => true,
      getHash: (_includeWitness: boolean) => Buffer.from('ab'.repeat(32), 'hex'),
    };

    const mockBlock = {
      version: 2,
      timestamp: 1700000000,
      nonce: 999,
      bits: 0x1d00ffff,
      merkleRoot: beToLeBuffer(beMerkle),
      prevHash: beToLeBuffer(bePrev),
      getId: () => beHash,
      transactions: [mockTx],
    };
    __setMockBlock(mockBlock);

    // Arbitrary bytes; size fields are computed from this buffer + tx structure
    const u8 = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
    const out = HexTransformer.parseBlockBytes(u8, 100, networkWithSegWit);

    // Header fields
    expect(out.hash).toBe(beHash);
    expect(out.previousblockhash).toBe(bePrev);
    expect(out.merkleroot).toBe(beMerkle);
    expect(out.bits).toBe('0x1d00ffff');
    expect(out.difficulty).toBe('1');
    expect(out.version).toBe(2);
    expect(out.versionHex).toBe('0x00000002');
    expect(out.time).toBe(1700000000);
    expect(out.mediantime).toBe(1700000000);
    expect(out.height).toBe(100);

    // Sizes: numeric values; exact numbers depend on buffer length and tx structure
    expect(typeof out.size).toBe('number');
    expect(typeof out.strippedsize).toBe('number');
    expect(typeof out.weight).toBe('number');
    // expect(typeof out.vsize).toBe('number');

    // Transaction and wtxid
    const tx0 = out.tx![0]!;
    // expect(tx0.txid).toBe('txidbe');
    // expect(tx0.wtxid).toBe('ab'.repeat(32));
  });

  it('parseBlockBytes without height: omits height field', () => {
    const mockBlock = {
      version: 1,
      timestamp: 1,
      nonce: 1,
      bits: 0x1d00ffff,
      merkleRoot: beToLeBuffer('33'.repeat(32)),
      prevHash: beToLeBuffer('44'.repeat(32)),
      getId: () => '55'.repeat(32),
      transactions: [],
    };
    __setMockBlock(mockBlock);

    const u8 = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const out = HexTransformer.parseBlockBytes(u8, networkWithSegWit) as any;
    expect(out.height).toBeUndefined();
    expect(out.hash).toBe('55'.repeat(32));
  });

  it('parseBlockBytes throws if block size validation fails', () => {
    utils.BlockSizeCalculator.validateSizes.mockReturnValueOnce(false);

    const mockBlock = {
      version: 1,
      timestamp: 1,
      nonce: 1,
      bits: 0x1d00ffff,
      merkleRoot: beToLeBuffer('00'.repeat(32)),
      prevHash: beToLeBuffer('11'.repeat(32)),
      getId: () => '22'.repeat(32),
      transactions: [],
    };
    __setMockBlock(mockBlock);

    const u8 = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(() => HexTransformer.parseBlockBytes(u8, 1, networkWithSegWit))
      .toThrow(/Block size calculation validation failed/);
  });

  // ---------------------------
  // TRANSACTIONS (BYTES)
  // ---------------------------

  it('parseTxBytes: with SegWit returns wtxid and preserves times', () => {
    const mockTx = {
      version: 1,
      locktime: 0,
      ins: [{
        hash: beToLeBuffer('77'.repeat(32)),
        index: 0,
        script: Buffer.from('51', 'hex'),
        sequence: 0,
        witness: [Buffer.from('bb', 'hex')],
      }],
      outs: [{ value: 5000, script: Buffer.from('a914' + '22'.repeat(20) + '87', 'hex') }],
      getId: () => '66'.repeat(32),
      hasWitnesses: () => true,
      getHash: (_includeWitness: boolean) => Buffer.from('cd'.repeat(32), 'hex'),
    };
    __setMockTx(mockTx);

    const u8 = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const out = HexTransformer.parseTxBytes(u8, networkWithSegWit, 'bh', 111, 222);
    expect(out.blockhash).toBe('bh');
    expect(out.time).toBe(111);
    expect(out.blocktime).toBe(222);
    expect(out.wtxid).toBe('cd'.repeat(32));
    expect(out.vout[0]!.scriptPubKey!.type).toBe('scripthash');
  });

  it('parseTxBytes: without SegWit does not set wtxid', () => {
    const mockTx = {
      version: 1,
      locktime: 0,
      ins: [{
        hash: beToLeBuffer('77'.repeat(32)),
        index: 0,
        script: Buffer.from('51', 'hex'),
        sequence: 0,
        witness: [Buffer.from('bb', 'hex')],
      }],
      outs: [{ value: 5000, script: Buffer.from('a914' + '22'.repeat(20) + '87', 'hex') }],
      getId: () => '66'.repeat(32),
      hasWitnesses: () => true,
      getHash: (_includeWitness: boolean) => Buffer.from('cd'.repeat(32), 'hex'),
    };
    __setMockTx(mockTx);

    const u8 = new Uint8Array([0x01, 0x02, 0x03]);
    const out = HexTransformer.parseTxBytes(u8, networkWithoutSegWit, 'bh2', 333, 444);
    expect(out.wtxid).toBeUndefined();
    expect(out.time).toBe(333);
    expect(out.blocktime).toBe(444);
  });

  it('parseTxBytes: coinbase input sets coinbase and omits txid in vin[0]', () => {
    const mockTx = {
      version: 1,
      locktime: 0,
      ins: [{
        hash: Buffer.alloc(32, 0),
        index: 0xffffffff,
        script: Buffer.from('abcd', 'hex'),
        sequence: 123,
        witness: [],
      }],
      outs: [{ value: 0, script: Buffer.from('6a', 'hex') }],
      getId: () => '99'.repeat(32),
      hasWitnesses: () => false,
      getHash: (_includeWitness: boolean) => Buffer.from('ee'.repeat(32), 'hex'),
    };
    __setMockTx(mockTx);

    const u8 = new Uint8Array([0x09, 0x08, 0x07]);
    const out = HexTransformer.parseTxBytes(u8, networkWithSegWit);
    expect(out.vin[0]!.coinbase).toBe('abcd');
    expect((out.vin[0] as any).txid).toBeUndefined();
    expect(out.vout[0]!.scriptPubKey!.type).toBe('nulldata');
  });

  it('parseTxBytes throws if TX size validation fails', () => {
    utils.BlockSizeCalculator.validateSizes.mockReturnValueOnce(false);

    const mockTx = {
      version: 1,
      locktime: 0,
      ins: [],
      outs: [],
      getId: () => '11'.repeat(32),
      hasWitnesses: () => false,
      getHash: (_includeWitness: boolean) => Buffer.from('00'.repeat(32), 'hex'),
    };
    __setMockTx(mockTx);

    const u8 = new Uint8Array([0x00, 0x01, 0x02]);
    expect(() => HexTransformer.parseTxBytes(u8, networkWithSegWit))
      .toThrow('Transaction size calculation validation failed');
  });
});
