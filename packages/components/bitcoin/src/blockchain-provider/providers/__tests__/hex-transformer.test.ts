import { HexTransformer } from '../hex-transformer';

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

jest.mock('../../utils', () => {
  const size = { strippedSize: 111, size: 222, weight: 888, vsize: 333 };
  const txSize = { size: 10, strippedSize: 9, weight: 40, vsize: 10 };
  return {
    BlockSizeCalculator: {
      calculateSizeFromHex: jest.fn(() => size),
      validateSizes: jest.fn(() => true),
      calculateTransactionSizeFromHex: jest.fn(() => txSize),
      calculateTransactionSizeFromBitcoinJS: jest.fn(() => txSize),
    },
  };
});

const { __setMockBlock, __setMockTx } = jest.requireMock('bitcoinjs-lib');

function beToLeBuffer(hex: string) {
  return Buffer.from(hex, 'hex').reverse();
}

describe('HexTransformer', () => {
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

  it('parseBlockHex produces BE header fields and difficulty, parses transactions with sizes', () => {
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
        { value: 123456789, script: Buffer.from('0014' + '11'.repeat(20), 'hex') },
        { value: 1000, script: Buffer.from('76a914' + '22'.repeat(20) + '88ac', 'hex') },
        { value: 0, script: Buffer.from('5120' + '33'.repeat(32), 'hex') },
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

    const out = HexTransformer.parseBlockHex('deadbeef', 100, networkWithSegWit);

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
    expect(out.size).toBe(222);
    expect(out.strippedsize).toBe(111);
    expect(out.weight).toBe(888);
    const firstTransaction = out.tx![0];
    expect(firstTransaction).toBeDefined();
  });

  it('parseBlockHex without height omits height field', () => {
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
    const out = HexTransformer.parseBlockHex('beef', networkWithSegWit) as any;
    expect(out.height).toBeUndefined();
    expect(out.hash).toBe('55'.repeat(32));
  });

  it('parseTransactionHex respects time and blocktime precedence and wtxid only with SegWit', () => {
    const mockTx = {
      version: 1,
      locktime: 0,
      ins: [
        {
          hash: beToLeBuffer('77'.repeat(32)),
          index: 0,
          script: Buffer.from('51', 'hex'),
          sequence: 0,
          witness: [Buffer.from('bb', 'hex')],
        },
      ],
      outs: [{ value: 5000, script: Buffer.from('a914' + '22'.repeat(20) + '87', 'hex') }],
      getId: () => '66'.repeat(32),
      hasWitnesses: () => true,
      getHash: (_includeWitness: boolean) => Buffer.from('cd'.repeat(32), 'hex'),
    };
    __setMockTx(mockTx);

    const outWithSegWit = HexTransformer.parseTransactionHex('aa', networkWithSegWit, 'bh', 111, 222);
    expect(outWithSegWit.time).toBe(111);
    expect(outWithSegWit.blocktime).toBe(222);
    expect(outWithSegWit.blockhash).toBe('bh');
    expect(outWithSegWit.wtxid).toBe('cd'.repeat(32));
    expect(outWithSegWit.vout[0]!.scriptPubKey!.type).toBe('scripthash');

    const outWithoutSegWit = HexTransformer.parseTransactionHex('aa', networkWithoutSegWit, 'bh2', 333, 444);
    expect(outWithoutSegWit.wtxid).toBeUndefined();
    expect(outWithoutSegWit.time).toBe(333);
    expect(outWithoutSegWit.blocktime).toBe(444);
  });

  it('coinbase input detection yields coinbase field and no txid', () => {
    const mockTx = {
      version: 1,
      locktime: 0,
      ins: [
        {
          hash: Buffer.alloc(32, 0),
          index: 0xffffffff,
          script: Buffer.from('abcd', 'hex'),
          sequence: 123,
          witness: [],
        },
      ],
      outs: [{ value: 0, script: Buffer.from('6a', 'hex') }],
      getId: () => '99'.repeat(32),
      hasWitnesses: () => false,
      getHash: (_includeWitness: boolean) => Buffer.from('ee'.repeat(32), 'hex'),
    };
    __setMockTx(mockTx);
    const out = HexTransformer.parseTransactionHex('aa', networkWithSegWit);
    expect(out.vin[0]!.coinbase).toBe('abcd');
    expect((out.vin[0] as any).txid).toBeUndefined();
    expect(out.vout[0]!.scriptPubKey!.type).toBe('nulldata');
  });

  it('throws when block size validation fails', () => {
    const utils = jest.requireMock('../../utils');
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
    expect(() => HexTransformer.parseBlockHex('aa', 1, networkWithSegWit)).toThrow('Block size calculation validation failed');
  });

  it('throws when transaction size validation fails', () => {
    const utils = jest.requireMock('../../utils');
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
    expect(() => HexTransformer.parseTransactionHex('aa', networkWithSegWit)).toThrow('Transaction size calculation validation failed');
  });
});
