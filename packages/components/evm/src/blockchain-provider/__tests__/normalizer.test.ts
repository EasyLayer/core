import { BlockchainNormalizer } from '../normalizer';
import { BlockSizeCalculator } from '../utils';
import type {
  UniversalBlock,
  UniversalTransaction,
  UniversalTransactionReceipt,
  UniversalLog,
  UniversalWithdrawal,
  UniversalAccessListEntry,
  NetworkConfig
} from '../node-providers';

// Mock the BlockSizeCalculator
jest.mock('../utils');

/**
 * Helper function to create a test network config
 */
function createNetworkConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    chainId: 1,
    nativeCurrencySymbol: 'ETH',
    nativeCurrencyDecimals: 18,
    blockTime: 12,
    hasEIP1559: true,
    hasWithdrawals: true,
    hasBlobTransactions: true,
    maxBlockSize: 30000000,
    maxBlockWeight: 30000000,
    maxGasLimit: 30000000,
    maxTransactionSize: 1000000,
    minGasPrice: 1000000000,
    maxBaseFeePerGas: 1000000000000,
    maxPriorityFeePerGas: 100000000000,
    maxBlobGasPerBlock: 786432,
    targetBlobGasPerBlock: 393216,
    maxCodeSize: 24576,
    maxInitCodeSize: 49152,
    ...overrides
  };
}

/**
 * Helper function to create a test universal withdrawal
 */
function createUniversalWithdrawal(overrides: Partial<UniversalWithdrawal> = {}): UniversalWithdrawal {
  return {
    index: '0x1',
    validatorIndex: '0x100',
    address: '0x' + 'a'.repeat(40),
    amount: '0x3b9aca00', // 1 ETH in Gwei
    ...overrides
  };
}

/**
 * Helper function to create a test universal log
 */
function createUniversalLog(overrides: Partial<UniversalLog> = {}): UniversalLog {
  return {
    address: '0x' + 'a'.repeat(40),
    topics: ['0x' + '1'.repeat(64)],
    data: '0x' + '2'.repeat(64),
    blockNumber: 100,
    transactionHash: '0x' + '3'.repeat(64),
    transactionIndex: 0,
    blockHash: '0x' + '4'.repeat(64),
    logIndex: 0,
    removed: false,
    ...overrides
  };
}

/**
 * Helper function to create a test universal transaction receipt
 */
function createUniversalReceipt(overrides: Partial<UniversalTransactionReceipt> = {}): UniversalTransactionReceipt {
  return {
    transactionHash: '0x' + 'a'.repeat(64),
    transactionIndex: 0,
    blockHash: '0x' + 'b'.repeat(64),
    blockNumber: 100,
    from: '0x' + '1'.repeat(40),
    to: '0x' + '2'.repeat(40),
    cumulativeGasUsed: 21000,
    gasUsed: 21000,
    contractAddress: null,
    logs: [createUniversalLog()],
    logsBloom: '0x' + '0'.repeat(512),
    status: '0x1',
    type: '0x0',
    effectiveGasPrice: 20000000000,
    ...overrides
  };
}

/**
 * Helper function to create a test universal transaction
 */
function createUniversalTransaction(overrides: Partial<UniversalTransaction> = {}): UniversalTransaction {
  return {
    hash: '0x' + 'a'.repeat(64),
    nonce: 0,
    from: '0x' + '1'.repeat(40),
    to: '0x' + '2'.repeat(40),
    value: '1000000000000000000', // 1 ETH
    gas: 21000,
    input: '0x',
    blockHash: '0x' + 'b'.repeat(64),
    blockNumber: 100,
    transactionIndex: 0,
    type: '0x0',
    chainId: 1,
    v: '0x1c',
    r: '0x' + '1'.repeat(64),
    s: '0x' + '2'.repeat(64),
    gasPrice: '20000000000', // 20 gwei
    ...overrides
  };
}

/**
 * Helper function to create a test universal block
 */
function createUniversalBlock(overrides: Partial<UniversalBlock> = {}): UniversalBlock {
  return {
    hash: '0x' + 'a'.repeat(64),
    parentHash: '0x' + 'b'.repeat(64),
    blockNumber: 100,
    nonce: '0x' + '0'.repeat(16),
    sha3Uncles: '0x' + '1'.repeat(64),
    logsBloom: '0x' + '0'.repeat(512),
    transactionsRoot: '0x' + '2'.repeat(64),
    stateRoot: '0x' + '3'.repeat(64),
    receiptsRoot: '0x' + '4'.repeat(64),
    miner: '0x' + '5'.repeat(40),
    difficulty: '0x1000000',
    totalDifficulty: '0x2000000',
    extraData: '0x',
    size: 1000,
    gasLimit: 8000000,
    gasUsed: 21000,
    timestamp: 1640995200,
    uncles: [],
    ...overrides
  };
}

describe('BlockchainNormalizer', () => {
  let normalizer: BlockchainNormalizer;
  let mockNetworkConfig: NetworkConfig;
  let mockBlockSizeCalculator: jest.Mocked<typeof BlockSizeCalculator>;

  beforeEach(() => {
    mockNetworkConfig = createNetworkConfig();
    normalizer = new BlockchainNormalizer(mockNetworkConfig);
    mockBlockSizeCalculator = BlockSizeCalculator as jest.Mocked<typeof BlockSizeCalculator>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('normalizeBlock', () => {
    it('should normalize a basic block successfully', () => {
      mockBlockSizeCalculator.calculateBlockSizeFromDecodedTransactions.mockReturnValue(800);

      const universalBlock = createUniversalBlock();
      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.hash).toBe('0x' + 'a'.repeat(64));
      expect(result.blockNumber).toBe(100);
      expect(result.parentHash).toBe('0x' + 'b'.repeat(64));
      expect(result.gasUsed).toBe(21000);
      expect(result.gasLimit).toBe(8000000);
      expect(result.size).toBe(1000); // Size without receipts since no receipts
      expect(result.sizeWithoutReceipts).toBe(1000);
    });

    it('should throw error when blockNumber is missing', () => {
      const universalBlock = createUniversalBlock({ blockNumber: undefined });

      expect(() => normalizer.normalizeBlock(universalBlock)).toThrow('Block is missing required blockNumber field');
    });

    it('should include EIP-1559 fields when network supports it', () => {
      const universalBlock = createUniversalBlock({ baseFeePerGas: '1000000000' });
      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.baseFeePerGas).toBe('1000000000');
    });

    it('should include withdrawal fields when network supports them', () => {
      const withdrawal = createUniversalWithdrawal();
      const universalBlock = createUniversalBlock({
        withdrawals: [withdrawal],
        withdrawalsRoot: '0x' + 'w'.repeat(64)
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.withdrawals).toHaveLength(1);
      expect(result.withdrawals![0]!.index).toBe('0x1');
      expect(result.withdrawals![0]!.validatorIndex).toBe('0x100');
      expect(result.withdrawalsRoot).toBe('0x' + 'w'.repeat(64));
    });

    it('should include blob transaction fields when network supports them', () => {
      const universalBlock = createUniversalBlock({
        blobGasUsed: '0x20000',
        excessBlobGas: '0x10000',
        parentBeaconBlockRoot: '0x' + 'beacon'.repeat(12) + '0'.repeat(8)
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.blobGasUsed).toBe('0x20000');
      expect(result.excessBlobGas).toBe('0x10000');
      expect(result.parentBeaconBlockRoot).toBe('0x' + 'beacon'.repeat(12) + '0'.repeat(8));
    });

    it('should normalize transactions when present', () => {
      const transaction = createUniversalTransaction();
      const universalBlock = createUniversalBlock({ transactions: [transaction] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions![0]!.hash).toBe('0x' + 'a'.repeat(64));
    });

    it('should normalize receipts and calculate sizes correctly', () => {
      mockBlockSizeCalculator.calculateBlockSizeFromDecodedTransactions.mockReturnValue(800);
      mockBlockSizeCalculator.calculateReceiptsSize.mockReturnValue(200);

      const receipt = createUniversalReceipt();
      const universalBlock = createUniversalBlock({ receipts: [receipt] });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.receipts).toHaveLength(1);
      expect(result.receipts![0]!.transactionHash).toBe('0x' + 'a'.repeat(64));
      expect(result.sizeWithoutReceipts).toBe(1000); // From rawBlock.size
      expect(result.size).toBe(1200); // 1000 + 200 receipts
    });

    it('should calculate block size from decoded transactions when rawBlock.size not available', () => {
      mockBlockSizeCalculator.calculateBlockSizeFromDecodedTransactions.mockReturnValue(900);

      const universalBlock = createUniversalBlock({ size: 0 });
      const result = normalizer.normalizeBlock(universalBlock);

      expect(mockBlockSizeCalculator.calculateBlockSizeFromDecodedTransactions).toHaveBeenCalled();
      expect(result.sizeWithoutReceipts).toBe(900);
    });
  });

  describe('normalizeTransaction', () => {
    it('should normalize a basic legacy transaction', () => {
      const universalTx = createUniversalTransaction();
      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.hash).toBe('0x' + 'a'.repeat(64));
      expect(result.from).toBe('0x' + '1'.repeat(40));
      expect(result.to).toBe('0x' + '2'.repeat(40));
      expect(result.value).toBe('1000000000000000000');
      expect(result.gas).toBe(21000);
      expect(result.type).toBe('0x0');
      expect(result.chainId).toBe(1);
      expect(result.gasPrice).toBe('20000000000');
    });

    it('should handle EIP-1559 transaction fields', () => {
      const universalTx = createUniversalTransaction({
        type: '0x2',
        maxFeePerGas: '30000000000',
        maxPriorityFeePerGas: '2000000000',
        gasPrice: undefined
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.type).toBe('0x2');
      expect(result.maxFeePerGas).toBe('30000000000');
      expect(result.maxPriorityFeePerGas).toBe('2000000000');
      expect(result.gasPrice).toBeUndefined();
    });

    it('should handle access list', () => {
      const accessList: UniversalAccessListEntry[] = [{
        address: '0x' + 'c'.repeat(40),
        storageKeys: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)]
      }];

      const universalTx = createUniversalTransaction({ accessList });
      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.accessList).toHaveLength(1);
      expect(result.accessList![0]!.address).toBe('0x' + 'c'.repeat(40));
      expect(result.accessList![0]!.storageKeys).toHaveLength(2);
    });

    it('should handle blob transaction fields', () => {
      const universalTx = createUniversalTransaction({
        type: '0x3',
        maxFeePerBlobGas: '100000000000',
        blobVersionedHashes: ['0x' + 'blob1'.repeat(15) + '0'.repeat(4), '0x' + 'blob2'.repeat(15) + '0'.repeat(4)]
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.maxFeePerBlobGas).toBe('100000000000');
      expect(result.blobVersionedHashes).toHaveLength(2);
    });

    it('should use network chainId when transaction chainId is missing', () => {
      const universalTx = createUniversalTransaction({ chainId: undefined });
      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.chainId).toBe(1); // From network config
    });

    it('should default transaction fields when missing', () => {
      const universalTx = createUniversalTransaction({
        blockHash: undefined,
        blockNumber: undefined,
        transactionIndex: undefined,
        type: undefined,
        v: undefined,
        r: undefined,
        s: undefined
      });

      const result = normalizer.normalizeTransaction(universalTx);

      expect(result.blockHash).toBe('');
      expect(result.blockNumber).toBe(0);
      expect(result.transactionIndex).toBe(0);
      expect(result.type).toBe('0x0');
      expect(result.v).toBe('');
      expect(result.r).toBe('');
      expect(result.s).toBe('');
    });
  });

  describe('normalizeTransactionReceipt', () => {
    it('should normalize a basic transaction receipt', () => {
      const universalReceipt = createUniversalReceipt();
      const result = normalizer.normalizeTransactionReceipt(universalReceipt);

      expect(result.transactionHash).toBe('0x' + 'a'.repeat(64));
      expect(result.blockNumber).toBe(100);
      expect(result.gasUsed).toBe(21000);
      expect(result.status).toBe('0x1');
      expect(result.logs).toHaveLength(1);
    });

    it('should throw error when blockNumber is missing', () => {
      const universalReceipt = createUniversalReceipt({ blockNumber: undefined });

      expect(() => normalizer.normalizeTransactionReceipt(universalReceipt)).toThrow('TransactionReceipt is missing required blockNumber field');
    });

    it('should include blob transaction receipt fields when network supports them', () => {
      const universalReceipt = createUniversalReceipt({
        blobGasUsed: '0x20000',
        blobGasPrice: '0x3b9aca00'
      });

      const result = normalizer.normalizeTransactionReceipt(universalReceipt);

      expect(result.blobGasUsed).toBe('0x20000');
      expect(result.blobGasPrice).toBe('0x3b9aca00');
    });

    it('should default receipt fields when missing', () => {
      const universalReceipt = createUniversalReceipt({
        type: undefined,
        effectiveGasPrice: undefined
      });

      const result = normalizer.normalizeTransactionReceipt(universalReceipt);

      expect(result.type).toBe('0x0');
      expect(result.effectiveGasPrice).toBe(0);
    });
  });

  describe('normalizeLog', () => {
    it('should normalize a basic log', () => {
      const universalLog = createUniversalLog();
      const result = normalizer.normalizeLog(universalLog);

      expect(result.address).toBe('0x' + 'a'.repeat(40));
      expect(result.topics).toHaveLength(1);
      expect(result.data).toBe('0x' + '2'.repeat(64));
      expect(result.blockNumber).toBe(100);
      expect(result.logIndex).toBe(0);
      expect(result.removed).toBe(false);
    });

    it('should default log fields when missing', () => {
      const universalLog = createUniversalLog({
        blockNumber: undefined,
        transactionHash: undefined,
        transactionIndex: undefined,
        blockHash: undefined,
        logIndex: undefined,
        removed: undefined
      });

      const result = normalizer.normalizeLog(universalLog);

      expect(result.blockNumber).toBe(0);
      expect(result.transactionHash).toBe('');
      expect(result.transactionIndex).toBe(0);
      expect(result.blockHash).toBe('');
      expect(result.logIndex).toBe(0);
      expect(result.removed).toBe(false);
    });
  });

  describe('network without features', () => {
    beforeEach(() => {
      mockNetworkConfig = createNetworkConfig({
        hasEIP1559: false,
        hasWithdrawals: false,
        hasBlobTransactions: false
      });
      normalizer = new BlockchainNormalizer(mockNetworkConfig);
    });

    it('should not include EIP-1559 fields when network does not support them', () => {
      const universalBlock = createUniversalBlock({ baseFeePerGas: '1000000000' });
      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.baseFeePerGas).toBeUndefined();
    });

    it('should not include withdrawal fields when network does not support them', () => {
      const withdrawal = createUniversalWithdrawal();
      const universalBlock = createUniversalBlock({
        withdrawals: [withdrawal],
        withdrawalsRoot: '0x' + 'w'.repeat(64)
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.withdrawals).toBeUndefined();
      expect(result.withdrawalsRoot).toBeUndefined();
    });

    it('should not include blob transaction fields when network does not support them', () => {
      const universalBlock = createUniversalBlock({
        blobGasUsed: '0x20000',
        excessBlobGas: '0x10000'
      });

      const result = normalizer.normalizeBlock(universalBlock);

      expect(result.blobGasUsed).toBeUndefined();
      expect(result.excessBlobGas).toBeUndefined();
    });

    it('should not include blob receipt fields when network does not support them', () => {
      const universalReceipt = createUniversalReceipt({
        blobGasUsed: '0x20000',
        blobGasPrice: '0x3b9aca00'
      });

      const result = normalizer.normalizeTransactionReceipt(universalReceipt);

      expect(result.blobGasUsed).toBeUndefined();
      expect(result.blobGasPrice).toBeUndefined();
    });
  });

  describe('getNetworkConfig', () => {
    it('should return the current network configuration', () => {
      const config = normalizer.getNetworkConfig();

      expect(config.chainId).toBe(1);
      expect(config.hasEIP1559).toBe(true);
      expect(config.nativeCurrencySymbol).toBe('ETH');
    });
  });

  describe('getBlockSizeBreakdown', () => {
    it('should calculate detailed block size breakdown', () => {
      mockBlockSizeCalculator.estimateBlockHeaderSize.mockReturnValue(500);
      mockBlockSizeCalculator.calculateTransactionSize.mockReturnValue(250);
      mockBlockSizeCalculator.calculateReceiptsSize.mockReturnValue(200);

      const transaction = createUniversalTransaction();
      const receipt = createUniversalReceipt();
      const normalizedTx = normalizer.normalizeTransaction(transaction);
      const normalizedReceipt = normalizer.normalizeTransactionReceipt(receipt);

      const block = {
        size: 1000,
        sizeWithoutReceipts: 800,
        transactions: [normalizedTx],
        receipts: [normalizedReceipt]
      } as any;

      const breakdown = normalizer.getBlockSizeBreakdown(block);

      expect(breakdown.total).toBe(1000);
      expect(breakdown.sizeWithoutReceipts).toBe(800);
      expect(breakdown.receiptsSize).toBe(200);
      expect(breakdown.header).toBe(500);
      expect(breakdown.transactions).toBe(250);
      expect(breakdown.receipts.total).toBe(200);
      expect(breakdown.receipts.count).toBe(1);
      expect(breakdown.receipts.averageSize).toBe(200);
    });

    it('should handle block without transactions and receipts', () => {
      mockBlockSizeCalculator.estimateBlockHeaderSize.mockReturnValue(500);

      const block = {
        size: 500,
        sizeWithoutReceipts: 500,
        transactions: undefined,
        receipts: undefined
      } as any;

      const breakdown = normalizer.getBlockSizeBreakdown(block);

      expect(breakdown.total).toBe(500);
      expect(breakdown.transactions).toBe(0);
      expect(breakdown.receipts.total).toBe(0);
      expect(breakdown.receipts.count).toBe(0);
      expect(breakdown.receipts.averageSize).toBe(0);
    });

    it('should handle transactions as string hashes', () => {
      mockBlockSizeCalculator.estimateBlockHeaderSize.mockReturnValue(500);

      const block = {
        size: 600,
        sizeWithoutReceipts: 600,
        transactions: ['0x' + 'hash1'.repeat(15) + '0'.repeat(4), '0x' + 'hash2'.repeat(15) + '0'.repeat(4)],
        receipts: undefined
      } as any;

      const breakdown = normalizer.getBlockSizeBreakdown(block);

      expect(breakdown.transactions).toBe(64); // 2 * 32 bytes for hashes
    });
  });
});