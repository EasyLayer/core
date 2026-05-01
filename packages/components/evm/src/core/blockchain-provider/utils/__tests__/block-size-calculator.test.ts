import { BlockSizeCalculator } from '../block-size-calculator';
import type { Block } from '../../components/block.interfaces';
import type { TransactionReceipt, Log } from '../../components/transaction.interfaces';

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    hash: '0x' + 'a'.repeat(64),
    parentHash: '0x' + '0'.repeat(64),
    blockNumber: 1,
    nonce: '0x0',
    sha3Uncles: '0x' + '1'.repeat(64),
    logsBloom: '0x' + '0'.repeat(512),
    transactionsRoot: '0x' + 'a'.repeat(64),
    stateRoot: '0x' + 'b'.repeat(64),
    receiptsRoot: '0x' + 'c'.repeat(64),
    miner: '0x' + 'f'.repeat(40),
    difficulty: '0x1',
    totalDifficulty: '0x1',
    extraData: '0x',
    gasLimit: 30_000_000,
    gasUsed: 21_000,
    timestamp: 1_700_000_000,
    uncles: [],
    size: 0,
    sizeWithoutReceipts: 0,
    ...overrides,
  } as Block;
}

function makeLog(): Log {
  return {
    address: '0x' + 'c'.repeat(40),
    topics: ['0x' + 'd'.repeat(64)],
    data: '0x' + '0'.repeat(64),
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: '0x' + 'e'.repeat(64),
    blockHash: '0x' + 'a'.repeat(64),
    blockNumber: 1,
    removed: false,
  };
}

function makeReceipt(logs: Log[] = []): TransactionReceipt {
  return {
    transactionHash: '0x' + 'e'.repeat(64),
    transactionIndex: 0,
    blockHash: '0x' + 'a'.repeat(64),
    blockNumber: 1,
    from: '0x' + 'f'.repeat(40),
    to: '0x' + '0'.repeat(40),
    cumulativeGasUsed: 21000,
    gasUsed: 21000,
    contractAddress: null,
    logs,
    logsBloom: '0x' + '0'.repeat(512),
    status: '0x1',
    type: '0x2',
    effectiveGasPrice: '1000000000',
  };
}

describe('BlockSizeCalculator', () => {
  describe('calculateBlockSizeFromDecodedTransactions', () => {
    it('returns 0 for block without transactions', () => {
      const block = makeBlock({ transactions: [] });
      const size = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(size).toBeGreaterThanOrEqual(0);
    });

    it('returns larger size for block with transactions', () => {
      const blockEmpty = makeBlock({ transactions: [] });
      const blockWithTx = makeBlock({
        transactions: [
          { hash: '0x' + 'e'.repeat(64), from: '0xsender', to: '0xreceiver', value: '0x0', nonce: 0, gas: 21000, input: '0x' } as any,
        ],
      });
      const emptySize = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockEmpty);
      const txSize = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockWithTx);
      expect(txSize).toBeGreaterThanOrEqual(emptySize);
    });

    it('includes withdrawal data when present', () => {
      const blockNoW = makeBlock({ transactions: [] });
      const blockW = makeBlock({
        transactions: [],
        withdrawals: [{ index: '0x1', validatorIndex: '0x1', address: '0xabc', amount: '0x1' }],
      });
      const sizeNoW = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockNoW);
      const sizeW = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(blockW);
      expect(sizeW).toBeGreaterThanOrEqual(sizeNoW);
    });

    it('is deterministic for same input', () => {
      const block = makeBlock({ transactions: [] });
      const s1 = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      const s2 = BlockSizeCalculator.calculateBlockSizeFromDecodedTransactions(block);
      expect(s1).toBe(s2);
    });
  });

  describe('calculateReceiptsSize', () => {
    it('returns 0 for empty receipts array', () => {
      expect(BlockSizeCalculator.calculateReceiptsSize([])).toBe(0);
    });

    it('returns positive size for receipt with logs', () => {
      const receipt = makeReceipt([makeLog(), makeLog()]);
      const size = BlockSizeCalculator.calculateReceiptsSize([receipt]);
      expect(size).toBeGreaterThan(0);
    });

    it('scales with number of receipts', () => {
      const receipt = makeReceipt([makeLog()]);
      const size1 = BlockSizeCalculator.calculateReceiptsSize([receipt]);
      const size3 = BlockSizeCalculator.calculateReceiptsSize([receipt, receipt, receipt]);
      expect(size3).toBeGreaterThan(size1);
    });

    it('receipt without logs is smaller than receipt with logs', () => {
      const empty = makeReceipt([]);
      const withLogs = makeReceipt([makeLog(), makeLog()]);
      const sEmpty = BlockSizeCalculator.calculateReceiptsSize([empty]);
      const sLogs = BlockSizeCalculator.calculateReceiptsSize([withLogs]);
      expect(sLogs).toBeGreaterThan(sEmpty);
    });
  });
});
