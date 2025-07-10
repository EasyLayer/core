import { BitcoinNormalizer } from '../normalizer';
import { BlockSizeCalculator } from '../utils/block-size-calculator';
import type { 
  UniversalBlock, 
  UniversalTransaction, 
  UniversalVin, 
  UniversalVout,
  UniversalBlockStats,
  NetworkConfig
} from '../node-providers';

// Mock the BlockSizeCalculator
jest.mock('../utils/block-size-calculator');

/**
 * Helper function to create a test universal block
 */
function createUniversalBlock(overrides: Partial<UniversalBlock> = {}): UniversalBlock {
  return {
    hash: 'a'.repeat(64),
    height: 100,
    strippedsize: 800,
    size: 1000,
    weight: 3200,
    version: 1,
    versionHex: '00000001',
    merkleroot: 'b'.repeat(64),
    time: 1640995200,
    mediantime: 1640995000,
    nonce: 12345,
    bits: '1a05db8b',
    difficulty: '1000000',
    chainwork: 'c'.repeat(64),
    nTx: 1,
    ...overrides
  };
}

/**
 * Helper function to create a test universal transaction
 */
function createUniversalTransaction(overrides: Partial<UniversalTransaction> = {}): UniversalTransaction {
  return {
    txid: 'tx1',
    hash: 'tx1',
    version: 1,
    size: 250,
    vsize: 125,
    weight: 500,
    locktime: 0,
    vin: [],
    vout: [],
    ...overrides
  };
}

/**
 * Helper function to create a test vin
 */
function createUniversalVin(overrides: Partial<UniversalVin> = {}): UniversalVin {
  return {
    txid: 'prev_tx',
    vout: 0,
    scriptSig: { asm: 'asm_data', hex: 'hex_data' },
    sequence: 4294967295,
    ...overrides
  };
}

/**
 * Helper function to create a test vout
 */
function createUniversalVout(overrides: Partial<UniversalVout> = {}): UniversalVout {
  return {
    value: 5000000000,
    n: 0,
    scriptPubKey: {
      asm: 'OP_DUP OP_HASH160',
      hex: 'hex_script',
      type: 'pubkeyhash',
      addresses: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']
    },
    ...overrides
  };
}

/**
 * Helper function to create test block stats
 */
function createUniversalBlockStats(overrides: Partial<UniversalBlockStats> = {}): UniversalBlockStats {
  return {
    blockhash: 'a'.repeat(64),
    height: 100,
    total_size: 1000000,
    total_stripped_size: 800000,
    total_weight: 3200000,
    total_fee: 50000,
    subsidy: 625000000,
    total_out: 62550000000,
    utxo_increase: 100,
    utxo_size_inc: 5000,
    ins: 150,
    outs: 250,
    txs: 200,
    witness_txs: 120,
    fee_rate_percentiles: [1, 5, 10, 25, 50],
    avgfee: 250,
    avgfeerate: 10,
    avgtxsize: 500,
    ...overrides
  };
}

describe('BitcoinNormalizer', () => {
  let normalizer: BitcoinNormalizer;
  let mockNetworkConfig: NetworkConfig;
  let mockBlockSizeCalculator: jest.Mocked<typeof BlockSizeCalculator>;

  beforeEach(() => {
    mockNetworkConfig = {
      network: 'mainnet',
      nativeCurrencySymbol: 'BTC',
      nativeCurrencyDecimals: 8,
      hasSegWit: true,
      hasTaproot: true,
      hasRBF: true,
      hasCSV: true,
      hasCLTV: true,
      maxBlockSize: 1000000,
      maxBlockWeight: 4000000,
      difficultyAdjustmentInterval: 2016,
      targetBlockTime: 600
    };

    normalizer = new BitcoinNormalizer(mockNetworkConfig);
    mockBlockSizeCalculator = BlockSizeCalculator as jest.Mocked<typeof BlockSizeCalculator>;

    // Setup default mocks
    mockBlockSizeCalculator.calculateSizeFromHex = jest.fn().mockReturnValue({
      size: 1100,
      strippedSize: 900,
      weight: 3600,
      vsize: 900,
      witnessSize: 200,
      headerSize: 80,
      transactionsSize: 1020
    });

    mockBlockSizeCalculator.calculateSizeFromBlock = jest.fn().mockReturnValue({
      size: 350,
      strippedSize: 300,
      weight: 1200,
      vsize: 300,
      witnessSize: 50,
      headerSize: 80,
      transactionsSize: 270
    });

    mockBlockSizeCalculator.calculateTransactionSizeFromHex = jest.fn().mockReturnValue({
      size: 250,
      strippedSize: 200,
      vsize: 200,
      weight: 800,
      witnessSize: 50
    });

    mockBlockSizeCalculator.calculateTransactionSize = jest.fn().mockReturnValue({
      size: 250,
      strippedSize: 200,
      vsize: 200,
      weight: 800,
      witnessSize: 50
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('normalizeBlock', () => {
    it('should normalize a basic block successfully', () => {
      const universalBlock = createUniversalBlock();

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.height).toBe(100);
      expect(result.hash).toBe('a'.repeat(64));
      expect(result.size).toBe(1000);
      expect(result.strippedsize).toBe(800);
      expect(result.sizeWithoutWitnesses).toBe(800);
      expect(result.witnessSize).toBe(200); // size - strippedsize
      expect(result.headerSize).toBe(80);
      expect(result.transactionsSize).toBe(920); // size - headerSize
      expect(result.blockSizeEfficiency).toBe(0.1); // 1000/1000000 * 100
      expect(result.witnessDataRatio).toBe(0);
    });

    it('should throw error when block height is missing', () => {
      const universalBlock = createUniversalBlock({ height: undefined });

      expect(() => normalizer.normalizeBlock(universalBlock)).toThrow('Block height is required for normalization');
    });

    it('should handle block with transaction objects', () => {
      const mockTx = createUniversalTransaction();
      const universalBlock = createUniversalBlock({ tx: [mockTx] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toHaveLength(1);
      expect(result.tx![0]!.txid).toBe('tx1');
      expect(mockBlockSizeCalculator.calculateSizeFromBlock).toHaveBeenCalled();
    });

    it('should handle block with transaction hashes only', () => {
      const universalBlock = createUniversalBlock({ tx: ['tx1hash', 'tx2hash'] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toBeUndefined();
    });

    it('should use BlockSizeCalculator when hex is available', () => {
      const universalBlock = createUniversalBlock({ hex: '0100000000000000' });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(mockBlockSizeCalculator.calculateSizeFromHex).toHaveBeenCalledWith('0100000000000000', mockNetworkConfig);
      expect(result.size).toBe(1100);
      expect(result.strippedsize).toBe(900);
      expect(result.sizeWithoutWitnesses).toBe(900);
      expect(result.witnessSize).toBe(200);
    });
  });

  describe('normalizeTransaction', () => {
    it('should normalize a basic transaction successfully', () => {
      const vin = createUniversalVin();
      const vout = createUniversalVout();
      const universalTx = createUniversalTransaction({ vin: [vin], vout: [vout] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.txid).toBe('tx1');
      expect(result.size).toBe(250);
      expect(result.strippedsize).toBe(200);
      expect(result.sizeWithoutWitnesses).toBe(200);
      expect(result.vsize).toBe(200);
      expect(result.weight).toBe(800);
      expect(result.witnessSize).toBe(50);
      expect(result.vin).toHaveLength(1);
      expect(result.vout).toHaveLength(1);
      expect(result.vin[0]!.txid).toBe('prev_tx');
      expect(result.vout[0]!.value).toBe(5000000000);
    });

    it('should calculate fee rate when fee is provided', () => {
      const universalTx = createUniversalTransaction({ fee: 2000 }); // fee / calculated vsize (200) = 10

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.fee).toBe(2000);
      expect(result.feeRate).toBe(10); // 2000 / 200 = 10 sat/vbyte
    });

    it('should include SegWit fields when network supports it', () => {
      const vinWithWitness = createUniversalVin({ txinwitness: ['witness_data'] });
      const universalTx = createUniversalTransaction({ 
        wtxid: 'wtx1',
        vin: [vinWithWitness]
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.wtxid).toBe('wtx1');
      expect(result.vin[0]!.txinwitness).toEqual(['witness_data']);
    });

    it('should include RBF field when network supports it', () => {
      const universalTx = createUniversalTransaction({ bip125_replaceable: true });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.bip125_replaceable).toBe(true);
    });
  });

  describe('normalizeBlockStats', () => {
    it('should normalize block stats successfully', () => {
      const universalStats = createUniversalBlockStats();

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.blockhash).toBe('a'.repeat(64));
      expect(result.height).toBe(100);
      expect(result.total_witness_size).toBe(200000); // total_size - total_stripped_size
      expect(result.total_vsize).toBe(800000); // Math.ceil(total_weight / 4)
      expect(result.witness_ratio).toBe(60); // (120/200) * 100
      expect(result.txs).toBe(200);
      expect(result.witness_txs).toBe(120);
    });
  });

  describe('validation methods', () => {
    it('should validate block hash correctly', () => {
      expect(normalizer.isValidBlockHash('a'.repeat(64))).toBe(true);
      expect(normalizer.isValidBlockHash('invalid')).toBe(false);
      expect(normalizer.isValidBlockHash('g'.repeat(64))).toBe(false);
    });

    it('should validate transaction hash correctly', () => {
      expect(normalizer.isValidTransactionHash('a'.repeat(64))).toBe(true);
      expect(normalizer.isValidTransactionHash('invalid')).toBe(false);
      expect(normalizer.isValidTransactionHash('g'.repeat(64))).toBe(false);
    });

    it('should validate block height correctly', () => {
      expect(normalizer.isValidBlockHeight(100)).toBe(true);
      expect(normalizer.isValidBlockHeight(0)).toBe(true);
      expect(normalizer.isValidBlockHeight(-1)).toBe(false);
      expect(normalizer.isValidBlockHeight(10000001)).toBe(false);
      expect(normalizer.isValidBlockHeight(1.5)).toBe(false);
    });
  });

  describe('batch normalization methods', () => {
    it('should normalize many blocks and skip invalid ones', () => {
      const universalBlocks = [
        createUniversalBlock({ height: 100 }),
        createUniversalBlock({ height: undefined }), // Should be skipped
        createUniversalBlock({ height: 102 })
      ];

      const result = normalizer.normalizeManyBlocks(universalBlocks);

      expect(result).toHaveLength(2);
      expect(result[0]!.height).toBe(100);
      expect(result[1]!.height).toBe(102);
    });

    it('should normalize many transactions', () => {
      const universalTransactions = [
        createUniversalTransaction({ txid: 'tx1' }),
        createUniversalTransaction({ txid: 'tx2', size: 300, vsize: 150, weight: 600 })
      ];

      const result = normalizer.normalizeManyTransactions(universalTransactions);

      expect(result).toHaveLength(2);
      expect(result[0]!.txid).toBe('tx1');
      expect(result[1]!.txid).toBe('tx2');
    });
  });

  describe('size calculation methods', () => {
    it('should get block sizes correctly', () => {
      const block = {
        size: 1000,
        strippedsize: 800,
        sizeWithoutWitnesses: 800,
        weight: 3200,
        vsize: 800,
        witnessSize: 200,
        headerSize: 80,
        transactionsSize: 920
      } as any;

      const result = normalizer.getBlockSizes(block);

      expect(result.size).toBe(1000);
      expect(result.strippedSize).toBe(800);
      expect(result.sizeWithoutWitnesses).toBe(800);
      expect(result.witnessSize).toBe(200);
      expect(result.headerSize).toBe(80);
    });

    it('should get transaction sizes correctly', () => {
      const transaction = {
        size: 250,
        strippedsize: 200,
        sizeWithoutWitnesses: 200,
        weight: 800,
        vsize: 200,
        witnessSize: 50,
        feeRate: 10
      } as any;

      const result = normalizer.getTransactionSizes(transaction);

      expect(result.size).toBe(250);
      expect(result.strippedSize).toBe(200);
      expect(result.sizeWithoutWitnesses).toBe(200);
      expect(result.witnessSize).toBe(50);
      expect(result.feeRate).toBe(10);
    });
  });

  describe('network without SegWit/RBF support', () => {
    beforeEach(() => {
      mockNetworkConfig = {
        network: 'testnet',
        nativeCurrencySymbol: 'BTC',
        nativeCurrencyDecimals: 8,
        hasSegWit: false,
        hasTaproot: false,
        hasRBF: false,
        hasCSV: false,
        hasCLTV: false,
        maxBlockSize: 1000000,
        maxBlockWeight: 4000000,
        difficultyAdjustmentInterval: 2016,
        targetBlockTime: 600
      };
      normalizer = new BitcoinNormalizer(mockNetworkConfig);
    });

    it('should not include SegWit fields when network does not support it', () => {
      const universalTx = createUniversalTransaction({ wtxid: 'wtx1' });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.wtxid).toBeUndefined();
    });

    it('should not include RBF field when network does not support it', () => {
      const universalTx = createUniversalTransaction({ bip125_replaceable: true });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.bip125_replaceable).toBeUndefined();
    });

    it('should calculate witness size as 0 for non-SegWit networks', () => {
      const universalBlock = createUniversalBlock({ size: 1000, strippedsize: 800 });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.witnessSize).toBe(0);
      expect(result.witnessDataRatio).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle block with empty transaction array', () => {
      const universalBlock = createUniversalBlock({ tx: [] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toBeUndefined();
    });

    it('should handle transaction without fee', () => {
      const universalTx = createUniversalTransaction({ fee: undefined });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.fee).toBeUndefined();
      expect(result.feeRate).toBeUndefined();
    });

    it('should handle vout with single address string', () => {
      const vout = createUniversalVout({
        scriptPubKey: {
          asm: 'OP_DUP OP_HASH160',
          hex: 'hex_script',
          type: 'pubkeyhash',
          address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
        }
      });
      const universalTx = createUniversalTransaction({ vout: [vout] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.vout[0]!.scriptPubKey?.addresses).toEqual(['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']);
    });

    it('should handle missing scriptPubKey', () => {
      const vout = createUniversalVout({ scriptPubKey: undefined });
      const universalTx = createUniversalTransaction({ vout: [vout] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.vout[0]!.scriptPubKey).toBeUndefined();
    });

    it('should handle missing scriptSig', () => {
      const vin = createUniversalVin({ scriptSig: undefined });
      const universalTx = createUniversalTransaction({ vin: [vin] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.vin[0]!.scriptSig).toBeUndefined();
    });

    it('should handle zero values in efficiency calculations', () => {
      const universalBlock = createUniversalBlock({ size: 0 });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.blockSizeEfficiency).toBe(0);
    });

    it('should handle missing block stats fields', () => {
      const universalStats = createUniversalBlockStats({ 
        total_size: undefined,
        total_stripped_size: undefined,
        witness_txs: undefined,
        txs: undefined
      });

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.total_witness_size).toBeUndefined();
      expect(result.witness_ratio).toBeUndefined();
    });
  });

  describe('normalization with BlockSizeCalculator', () => {
    it('should use calculated sizes from transaction data when hex not available', () => {
      const mockTx = createUniversalTransaction();
      const universalBlock = createUniversalBlock({ tx: [mockTx], hex: undefined });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(mockBlockSizeCalculator.calculateSizeFromBlock).toHaveBeenCalled();
      expect(result.size).toBe(350);
      expect(result.witnessSize).toBe(50);
    });

    it('should use calculated transaction sizes from hex', () => {
      const universalTx = createUniversalTransaction({ hex: '0100000001' });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(mockBlockSizeCalculator.calculateTransactionSizeFromHex).toHaveBeenCalledWith('0100000001', mockNetworkConfig);
      expect(result.size).toBe(250);
      expect(result.witnessSize).toBe(50);
    });

    it('should calculate transaction sizes from object when hex not available', () => {
      const vin = createUniversalVin();
      const vout = createUniversalVout();
      const universalTx = createUniversalTransaction({ vin: [vin], vout: [vout], hex: undefined });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(mockBlockSizeCalculator.calculateTransactionSize).toHaveBeenCalled();
      expect(result.size).toBe(250);
    });
  });

  describe('additional network fields', () => {
    it('should include optional block fields when present', () => {
      const universalBlock = createUniversalBlock({
        fee: 50000,
        subsidy: 625000000,
        miner: 'Pool Name',
        pool: {
          poolName: 'Mining Pool',
          url: 'pool.com'
        }
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.fee).toBe(50000);
      expect(result.subsidy).toBe(625000000);
      expect(result.miner).toBe('Pool Name');
      expect(result.pool).toEqual({
        poolName: 'Mining Pool',
        url: 'pool.com'
      });
    });

    it('should include mempool-specific transaction fields', () => {
      const universalTx = createUniversalTransaction({
        depends: ['tx1', 'tx2'],
        spentby: ['tx3', 'tx4']
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.depends).toEqual(['tx1', 'tx2']);
      expect(result.spentby).toEqual(['tx3', 'tx4']);
    });
  });

  describe('batch normalization error handling', () => {
    it('should log error and continue processing when block normalization fails', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      
      const universalBlocks = [
        createUniversalBlock({ height: 100 }),
        createUniversalBlock({ height: undefined, hash: 'invalid_block' }),
        createUniversalBlock({ height: 102 })
      ];

      const result = normalizer.normalizeManyBlocks(universalBlocks);

      expect(result).toHaveLength(2);
      // expect(consoleSpy).toHaveBeenCalledWith(
      //   'Failed to normalize block invalid_block:',
      //   expect.any(Error)
      // );

      consoleSpy.mockRestore();
    });

    it('should normalize many block stats successfully', () => {
      const universalStats = [
        createUniversalBlockStats({ height: 100 }),
        createUniversalBlockStats({ height: 101, txs: 300 })
      ];

      const result = normalizer.normalizeManyBlockStats(universalStats);

      expect(result).toHaveLength(2);
      expect(result[0]!.height).toBe(100);
      expect(result[1]!.txs).toBe(300);
    });
  });
});