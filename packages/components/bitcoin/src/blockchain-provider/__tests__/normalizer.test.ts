import { BitcoinNormalizer } from '../normalizer';
import type { 
  UniversalBlock, 
  UniversalTransaction, 
  UniversalVin, 
  UniversalVout,
  UniversalBlockStats,
  NetworkConfig
} from '../node-providers';

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
  });

  describe('normalizeBlock', () => {
    it('should normalize a basic block with complete size data', () => {
      const universalBlock = createUniversalBlock();

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.height).toBe(100);
      expect(result.hash).toBe('a'.repeat(64));
      expect(result.size).toBe(1000);
      expect(result.strippedsize).toBe(800);
      expect(result.sizeWithoutWitnesses).toBe(800);
      expect(result.weight).toBe(3200);
      expect(result.vsize).toBe(800); // Math.ceil(3200 / 4)
      expect(result.witnessSize).toBe(200); // size - strippedsize (1000 - 800)
      expect(result.headerSize).toBe(80);
      expect(result.transactionsSize).toBe(920); // size - headerSize (1000 - 80)
      expect(result.blockSizeEfficiency).toBe(0.1); // (1000/1000000) * 100
      expect(result.witnessDataRatio).toBe(20); // (200/1000) * 100
    });

    it('should throw error when block height is missing', () => {
      const universalBlock = createUniversalBlock({ height: undefined });

      expect(() => normalizer.normalizeBlock(universalBlock)).toThrow(
        'Block height is required but missing for block'
      );
    });

    it('should handle block with transaction objects', () => {
      const mockTx = createUniversalTransaction();
      const universalBlock = createUniversalBlock({ tx: [mockTx] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toHaveLength(1);
      expect(result.tx![0]!.txid).toBe('tx1');
    });

    it('should handle block with transaction hashes only', () => {
      const universalBlock = createUniversalBlock({ tx: ['tx1hash', 'tx2hash'] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toEqual([]);
    });

    it('should handle block with mixed transaction types', () => {
      const mockTx = createUniversalTransaction();
      const universalBlock = createUniversalBlock({ tx: ['tx1hash', mockTx] as any });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toHaveLength(1);
      expect(result.tx![0]!.txid).toBe('tx1');
    });

    it('should handle block without SegWit data', () => {
      const universalBlock = createUniversalBlock({ 
        size: 800, 
        strippedsize: 800, // Same size = no witness data
        weight: 3200 
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.witnessSize).toBeUndefined(); // No witness data
      expect(result.witnessDataRatio).toBeUndefined();
    });

    it('should calculate efficiency metrics correctly', () => {
      const universalBlock = createUniversalBlock({ 
        size: 500000, // Half of max block size
        strippedsize: 400000 
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.blockSizeEfficiency).toBe(50); // (500000/1000000) * 100
      expect(result.witnessDataRatio).toBe(20); // (100000/500000) * 100
    });

    it('should handle zero weight correctly', () => {
      const universalBlock = createUniversalBlock({ weight: 0, strippedsize: 800 });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.vsize).toBe(800); // Falls back to strippedsize when weight is 0
    });

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
  });

  describe('normalizeTransaction', () => {
    it('should normalize a basic transaction with complete data', () => {
      const vin = createUniversalVin();
      const vout = createUniversalVout();
      const universalTx = createUniversalTransaction({ vin: [vin], vout: [vout] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.txid).toBe('tx1');
      expect(result.size).toBe(250);
      expect(result.vsize).toBe(125);
      expect(result.weight).toBe(500);
      expect(result.vin).toHaveLength(1);
      expect(result.vout).toHaveLength(1);
      expect(result.vin[0]!.txid).toBe('prev_tx');
      expect(result.vout[0]!.value).toBe(5000000000);
    });

    it('should calculate fee rate when fee is provided', () => {
      const universalTx = createUniversalTransaction({ fee: 2500, vsize: 125 }); // 2500 / 125 = 20

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.fee).toBe(2500);
      expect(result.feeRate).toBe(20); // 2500 / 125 = 20 sat/vbyte
    });

    it('should not calculate fee rate when fee is missing', () => {
      const universalTx = createUniversalTransaction({ fee: undefined });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.fee).toBeUndefined();
      expect(result.feeRate).toBeUndefined();
    });

    it('should include SegWit fields when available', () => {
      const vinWithWitness = createUniversalVin({ txinwitness: ['witness_data'] });
      const universalTx = createUniversalTransaction({ 
        wtxid: 'wtx1',
        vin: [vinWithWitness]
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.wtxid).toBe('wtx1');
      expect(result.vin[0]!.txinwitness).toEqual(['witness_data']);
    });

    it('should include RBF field when available', () => {
      const universalTx = createUniversalTransaction({ bip125_replaceable: true });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.bip125_replaceable).toBe(true);
    });

    it('should calculate transaction size metrics for SegWit', () => {
      const universalTx = createUniversalTransaction({ 
        size: 250, 
        weight: 600, // (base_size * 4) + witness_size 
        vsize: 150 
      });

      const result = normalizer.normalizeTransaction(universalTx);

      // Estimated base size: Math.floor((600 + 3) / 4) = 150
      expect(result.strippedsize).toBe(150);
      expect(result.sizeWithoutWitnesses).toBe(150);
      expect(result.witnessSize).toBe(100); // 250 - 150
    });

    it('should handle transaction without SegWit data', () => {
      const universalTx = createUniversalTransaction({ 
        size: 250, 
        weight: 1000, // (250 * 4) = 1000, no witness data
        vsize: 250 
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.strippedsize).toBe(250);
      expect(result.witnessSize).toBeUndefined();
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

    it('should handle block context fields in transaction', () => {
      const universalTx = createUniversalTransaction({
        blockhash: 'block_hash_123',
        time: 1640995200,
        blocktime: 1640995300
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.blockhash).toBe('block_hash_123');
      expect(result.time).toBe(1640995200);
      expect(result.blocktime).toBe(1640995300);
    });
  });

  describe('normalizeBlockStats', () => {
    it('should normalize block stats successfully', () => {
      const universalStats = createUniversalBlockStats();

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.blockhash).toBe('a'.repeat(64));
      expect(result.height).toBe(100);
      expect(result.total_size).toBe(1000000);
      expect(result.total_stripped_size).toBe(800000);
      expect(result.total_witness_size).toBe(200000); // total_size - total_stripped_size
      expect(result.total_vsize).toBe(800000); // Math.ceil(total_weight / 4)
      expect(result.witness_ratio).toBe(60); // (120/200) * 100
      expect(result.txs).toBe(200);
      expect(result.witness_txs).toBe(120);
    });

    it('should handle missing witness statistics', () => {
      const universalStats = createUniversalBlockStats({ 
        witness_txs: undefined,
        txs: undefined,
        total_stripped_size: undefined 
      });

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.total_witness_size).toBeUndefined();
      expect(result.witness_ratio).toBeUndefined();
    });

    it('should calculate witness ratio correctly', () => {
      const universalStats = createUniversalBlockStats({ 
        witness_txs: 75, 
        txs: 100 
      });

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.witness_ratio).toBe(75); // (75/100) * 100
    });
  });

  describe('batch normalization methods', () => {
    it('should normalize many blocks', () => {
      const universalBlocks = [
        createUniversalBlock({ height: 100, hash: 'block1' }),
        createUniversalBlock({ height: 101, hash: 'block2' })
      ];

      const result = normalizer.normalizeManyBlocks(universalBlocks);

      expect(result).toHaveLength(2);
      expect(result[0]!.height).toBe(100);
      expect(result[0]!.hash).toBe('block1');
      expect(result[1]!.height).toBe(101);
      expect(result[1]!.hash).toBe('block2');
    });

    it('should throw error for blocks with missing height in batch', () => {
      const universalBlocks = [
        createUniversalBlock({ height: 100 }),
        createUniversalBlock({ height: undefined }), // Should throw
        createUniversalBlock({ height: 102 })
      ];

      expect(() => normalizer.normalizeManyBlocks(universalBlocks)).toThrow();
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
      expect(result[1]!.size).toBe(300);
    });

    it('should normalize many block stats', () => {
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

  describe('network without SegWit support', () => {
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

    it('should not calculate witness size for non-SegWit networks', () => {
      const universalBlock = createUniversalBlock({ size: 1000, strippedsize: 800 });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.witnessSize).toBeUndefined();
      expect(result.witnessDataRatio).toBeUndefined();
    });

    it('should handle transaction size calculation without SegWit', () => {
      const universalTx = createUniversalTransaction({ 
        size: 250, 
        weight: 1000 
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.strippedsize).toBe(250); // Same as size for non-SegWit
      expect(result.witnessSize).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle block with empty transaction array', () => {
      const universalBlock = createUniversalBlock({ tx: [] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.tx).toEqual([]);
    });

    it('should handle transaction without fee', () => {
      const universalTx = createUniversalTransaction({ fee: undefined });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.fee).toBeUndefined();
      expect(result.feeRate).toBeUndefined();
    });

    it('should handle vout with addresses array', () => {
      const vout = createUniversalVout({
        scriptPubKey: {
          asm: 'OP_DUP OP_HASH160',
          hex: 'hex_script',
          type: 'pubkeyhash',
          addresses: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2']
        }
      });
      const universalTx = createUniversalTransaction({ vout: [vout] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.vout[0]!.scriptPubKey?.addresses).toEqual([
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 
        '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
      ]);
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
      expect(result.witnessDataRatio).toBeUndefined(); // No witness data when size is 0
    });

    it('should handle missing block stats fields', () => {
      const universalStats = createUniversalBlockStats({ 
        total_size: 0,
        total_stripped_size: undefined,
        witness_txs: undefined,
        txs: 0
      });

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.total_witness_size).toBeUndefined();
      expect(result.witness_ratio).toBeUndefined();
    });

    it('should handle coinbase transaction input', () => {
      const coinbaseVin = createUniversalVin({ 
        txid: undefined,
        vout: undefined,
        coinbase: 'coinbase_data',
        scriptSig: undefined
      });
      const universalTx = createUniversalTransaction({ vin: [coinbaseVin] });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.vin[0]!.coinbase).toBe('coinbase_data');
      expect(result.vin[0]!.txid).toBeUndefined();
      expect(result.vin[0]!.vout).toBeUndefined();
    });
  });

  describe('size calculation edge cases', () => {
    it('should handle blocks with very large witness data ratio', () => {
      const universalBlock = createUniversalBlock({ 
        size: 1000000, // Max block size
        strippedsize: 200000, // Small base, large witness
        weight: 4000000 // Max weight
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.blockSizeEfficiency).toBe(100); // Full block
      expect(result.witnessDataRatio).toBe(80); // (800000/1000000) * 100
      expect(result.vsize).toBe(1000000); // Math.ceil(4000000 / 4)
    });

    it('should handle transaction with zero weight edge case', () => {
      const universalTx = createUniversalTransaction({ 
        size: 250, 
        weight: 0 
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.strippedsize).toBe(250); // Falls back to original size
      expect(result.witnessSize).toBeUndefined();
    });

    it('should handle block stats with perfect witness usage', () => {
      const universalStats = createUniversalBlockStats({ 
        witness_txs: 200, 
        txs: 200, // All transactions use witness
        total_size: 1000000,
        total_stripped_size: 600000
      });

      const result = normalizer.normalizeBlockStats(universalStats);

      expect(result.witness_ratio).toBe(100); // (200/200) * 100
      expect(result.total_witness_size).toBe(400000); // 1000000 - 600000
    });
  });
});