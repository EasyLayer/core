import { BlockchainNormalizer } from '../normalizer';
import type { NetworkConfig } from '../providers/interfaces';
import type { UniversalBlock, UniversalTransaction, UniversalTransactionReceipt } from '../providers/interfaces';

const BASE_NETWORK: NetworkConfig = {
  chainId: 1,
  nativeCurrencySymbol: 'ETH',
  nativeCurrencyDecimals: 18,
  blockTime: 12,
  hasEIP1559: true,
  hasWithdrawals: true,
  hasBlobTransactions: false,
  maxBlockSize: 4_000_000,
  maxBlockWeight: 4_000_000,
  maxGasLimit: 30_000_000,
  maxTransactionSize: 131_072,
  minGasPrice: '1000000000',
  maxCodeSize: 24_576,
  maxInitCodeSize: 49_152,
  supportsTraces: true,
  targetBlockTimeMs: 12_000,
};

function rawBlock(overrides: Partial<UniversalBlock> = {}): UniversalBlock {
  return {
    hash: '0xabc0000000000000000000000000000000000000000000000000000000000001',
    parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: '0x' + '0'.repeat(512),
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0xd7f8974fb5ac78d9ac099b9ad5018bedc2ce0a72dad1827a1709da30580f0544',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    miner: '0x' + 'f'.repeat(40),
    difficulty: '0x1',
    totalDifficulty: '0x1',
    extraData: '0x',
    size: 0x27c,   // 636 decimal
    gasLimit: 0x1c9c380,
    gasUsed: 0x5208,
    timestamp: 0x656be7c0,
    uncles: [],
    blockNumber: 19_000_000,
    baseFeePerGas: '0x3b9aca00',
    ...overrides,
  };
}

function rawTx(overrides: Partial<UniversalTransaction> = {}): UniversalTransaction {
  return {
    hash: '0x' + 'e'.repeat(64),
    nonce: 0x1,
    from: '0x' + 'a'.repeat(40),
    to: '0x' + 'b'.repeat(40),
    value: '0x0',
    gas: 0x5208,
    input: '0x',
    blockHash: '0xabc0000000000000000000000000000000000000000000000000000000000001',
    blockNumber: 19_000_000,
    transactionIndex: 0,
    gasPrice: '0x3b9aca00',
    type: '0x2',
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x77359400',
    chainId: 1,
    v: '0x1',
    r: '0x' + 'a'.repeat(64),
    s: '0x' + 'b'.repeat(64),
    ...overrides,
  };
}

describe('BlockchainNormalizer', () => {
  let normalizer: BlockchainNormalizer;

  beforeEach(() => {
    normalizer = new BlockchainNormalizer(BASE_NETWORK);
  });

  describe('normalizeBlock', () => {
    it('correctly converts hex fields to numbers', () => {
      const block = normalizer.normalizeBlock(rawBlock());
      expect(block.blockNumber).toBe(19_000_000);
      expect(block.gasLimit).toBe(30_000_000);
      expect(block.gasUsed).toBe(21_000);
      expect(block.timestamp).toBe(1_701_570_496);
    });

    it('includes baseFeePerGas when hasEIP1559=true', () => {
      const block = normalizer.normalizeBlock(rawBlock({ baseFeePerGas: '0x3b9aca00' }));
      expect(block.baseFeePerGas).toBe('1000000000');
    });

    it('omits baseFeePerGas when hasEIP1559=false', () => {
      const net: NetworkConfig = { ...BASE_NETWORK, hasEIP1559: false };
      const n = new BlockchainNormalizer(net);
      const block = n.normalizeBlock(rawBlock({ baseFeePerGas: '0x3b9aca00' }));
      expect(block.baseFeePerGas).toBeUndefined();
    });

    it('includes withdrawals when hasWithdrawals=true', () => {
      const withdrawal = { index: '0x1', validatorIndex: '0x100', address: '0x' + 'f'.repeat(40), amount: '0x1' };
      const block = normalizer.normalizeBlock(rawBlock({ withdrawals: [withdrawal] }));
      expect(block.withdrawals).toHaveLength(1);
      expect(block.withdrawals![0]).toMatchObject({
        index: '1',
        validatorIndex: '256',
        address: withdrawal.address,
        amount: '1',
      });
    });

    it('omits withdrawals when hasWithdrawals=false', () => {
      const net: NetworkConfig = { ...BASE_NETWORK, hasWithdrawals: false };
      const n = new BlockchainNormalizer(net);
      const withdrawal = { index: '0x1', validatorIndex: '0x1', address: '0xaddr', amount: '0x1' };
      const block = n.normalizeBlock(rawBlock({ withdrawals: [withdrawal] }));
      expect(block.withdrawals).toBeUndefined();
    });

    it('includes blob fields when hasBlobTransactions=true', () => {
      const net: NetworkConfig = { ...BASE_NETWORK, hasBlobTransactions: true };
      const n = new BlockchainNormalizer(net);
      const block = n.normalizeBlock(rawBlock({ blobGasUsed: '0x20000', excessBlobGas: '0x0' }));
      expect(block.blobGasUsed).toBe('131072');
      expect(block.excessBlobGas).toBe('0');
    });

    it('throws when blockNumber is missing', () => {
      const raw = rawBlock();
      delete (raw as any).blockNumber;
      expect(() => normalizer.normalizeBlock(raw)).toThrow();
    });

    it('calculates size fields', () => {
      const block = normalizer.normalizeBlock(rawBlock({ transactions: [rawTx()] }));
      expect(block.size).toBeGreaterThanOrEqual(0);
      expect(block.sizeWithoutReceipts).toBeGreaterThanOrEqual(0);
    });
  });

  describe('fork/client optional fields', () => {
    it('does not synthesize optional fork/client fields when provider omits them', () => {
      const raw = rawBlock({
        nonce: undefined,
        logsBloom: undefined,
        receiptsRoot: undefined,
        difficulty: undefined,
        totalDifficulty: undefined,
      });

      const block = normalizer.normalizeBlock(raw);

      expect(block.nonce).toBeUndefined();
      expect(block.logsBloom).toBeUndefined();
      expect(block.receiptsRoot).toBeUndefined();
      expect(block.difficulty).toBeUndefined();
      expect(block.totalDifficulty).toBeUndefined();
    });

    it('fails fast when field policy marks totalDifficulty as required', () => {
      const strict = new BlockchainNormalizer({
        ...BASE_NETWORK,
        fieldPolicy: { allowMissingTotalDifficulty: false },
      });

      expect(() => strict.normalizeBlock(rawBlock({ totalDifficulty: undefined }))).toThrow('totalDifficulty');
    });
  });

  describe('normalizeTransaction', () => {
    it('normalizes legacy type-0 transaction', () => {
      const tx = normalizer.normalizeTransaction(rawTx({ type: '0x0', gasPrice: '0xee6b2800' }));
      expect(tx.type).toBe('0x0');
      expect(tx.gasPrice).toBe('4000000000');
    });

    it('normalizes EIP-1559 type-2 transaction', () => {
      const tx = normalizer.normalizeTransaction(rawTx({ type: '0x2' }));
      expect(tx.type).toBe('0x2');
      expect(tx.maxFeePerGas).toBeDefined();
      expect(tx.maxPriorityFeePerGas).toBeDefined();
    });

    it('normalizes contract deployment (to=null)', () => {
      const tx = normalizer.normalizeTransaction(rawTx({ to: null }));
      expect(tx.to).toBeNull();
    });

    it('includes accessList when present', () => {
      const accessList = [{ address: '0x' + 'c'.repeat(40), storageKeys: ['0x' + '1'.repeat(64)] }];
      const tx = normalizer.normalizeTransaction(rawTx({ accessList }));
      expect(tx.accessList).toEqual(accessList);
    });
  });

  describe('receipt compatibility', () => {
    it('keeps legacy receipt root and does not require status when policy allows it', () => {
      const receiptRaw: UniversalTransactionReceipt = {
        transactionHash: '0x' + 'e'.repeat(64),
        transactionIndex: 0,
        blockHash: '0x' + 'a'.repeat(64),
        blockNumber: 1,
        from: '0x' + 'a'.repeat(40),
        to: '0x' + 'b'.repeat(40),
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [],
        root: '0x' + '1'.repeat(64),
      };

      const receipt = normalizer.normalizeTransactionReceipt(receiptRaw);

      expect(receipt.status).toBeUndefined();
      expect(receipt.root).toBe(receiptRaw.root);
    });

    it('does not synthesize effectiveGasPrice when provider omits it', () => {
      const receiptRaw: UniversalTransactionReceipt = {
        transactionHash: '0x' + 'e'.repeat(64),
        transactionIndex: 0,
        blockHash: '0x' + 'a'.repeat(64),
        blockNumber: 1,
        from: '0x' + 'a'.repeat(40),
        to: '0x' + 'b'.repeat(40),
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [],
        status: '0x1',
      };

      const receipt = normalizer.normalizeTransactionReceipt(receiptRaw);

      expect(receipt.effectiveGasPrice).toBeUndefined();
      expect(receipt.logsBloom).toBeUndefined();
    });
  });

  describe('normalizeTransactionReceipt', () => {
    it('normalizes status correctly', () => {
      const okReceipt: UniversalTransactionReceipt = {
        transactionHash: '0x' + 'e'.repeat(64),
        transactionIndex: 0,
        blockHash: '0x' + 'a'.repeat(64),
        blockNumber: 1,
        from: '0x' + 'a'.repeat(40),
        to: '0x' + 'b'.repeat(40),
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        status: '0x1',
        type: '0x2',
        effectiveGasPrice: '1000000000',
      };
      const receipt = normalizer.normalizeTransactionReceipt(okReceipt);
      expect(receipt.status).toBe('0x1');
    });

    it('normalizes failed transaction (status=0x0)', () => {
      const failReceipt: UniversalTransactionReceipt = {
        transactionHash: '0x' + 'e'.repeat(64),
        transactionIndex: 0,
        blockHash: '0x' + 'a'.repeat(64),
        blockNumber: 1,
        from: '0x' + 'a'.repeat(40),
        to: null,
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: '0x' + 'c'.repeat(40),
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        status: '0x0',
      };
      const receipt = normalizer.normalizeTransactionReceipt(failReceipt);
      expect(receipt.status).toBe('0x0');
    });

    it('normalizes logs inside receipts', () => {
      const logRaw = {
        address: '0x' + 'c'.repeat(40),
        topics: ['0x' + 'd'.repeat(64)],
        data: '0x' + '0'.repeat(64),
        logIndex: '0x0',
        transactionIndex: '0x0',
        transactionHash: '0x' + 'e'.repeat(64),
        blockHash: '0x' + 'a'.repeat(64),
        blockNumber: '0x1',
        removed: false,
      };
      const receiptRaw: any = {
        transactionHash: '0x' + 'e'.repeat(64),
        transactionIndex: 0,
        blockHash: '0x' + 'a'.repeat(64),
        blockNumber: 1,
        from: '0x' + 'a'.repeat(40),
        to: '0x' + 'b'.repeat(40),
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [logRaw],
        logsBloom: '0x' + '0'.repeat(512),
        status: '0x1',
      };
      const receipt = normalizer.normalizeTransactionReceipt(receiptRaw);
      expect(receipt.logs).toHaveLength(1);
      expect(receipt.logs[0]!.address).toBe(logRaw.address);
      expect(receipt.logs[0]!.topics).toEqual(logRaw.topics);
    });
  });
});
