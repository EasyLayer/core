import { BlocksQueue } from '../blocks-queue';
import { Block } from '../../blockchain-provider';

describe('BlocksQueue', () => {
  let queue: BlocksQueue<Block>;
  const defaultOptions = {
    lastHeight: 100,
    maxQueueSize: 10000,
    blockSize: 1000,
    maxBlockHeight: 200
  };

  beforeEach(() => {
    queue = new BlocksQueue<Block>(defaultOptions);
  });

  describe('Enqueue Operation', () => {
    function createMockBlock(blockNumber: number, overrides: Partial<Block> = {}): Block {
      return {
        blockNumber,
        hash: '0xblock' + blockNumber.toString().padStart(60, '0'),
        parentHash: '0xparent' + '0'.repeat(58),
        nonce: '0x0000000000000042',
        sha3Uncles: '0xuncles' + '0'.repeat(58),
        logsBloom: '0x' + '0'.repeat(512),
        transactionsRoot: '0xtxroot' + '0'.repeat(57),
        stateRoot: '0xstate' + '0'.repeat(59),
        receiptsRoot: '0xreceipts' + '0'.repeat(55),
        miner: '0xminer' + '0'.repeat(54),
        difficulty: '1000000',
        totalDifficulty: '2000000',
        extraData: '0x',
        size: 1000,
        gasLimit: 8000000,
        gasUsed: 21000,
        timestamp: Date.now(),
        uncles: [],
        transactions: [],
        ...overrides
      };
    }

    it('should successfully enqueue a valid block', async () => {
      const block = createMockBlock(101, { size: 500 });
      
      await queue.enqueue(block);
      
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(101);
      expect(queue.currentSize).toBe(500);
    });

    it('should throw error when block height is not sequential', async () => {
      const block = createMockBlock(102); // Should be 101
      
      await expect(queue.enqueue(block)).rejects.toThrow(
        'Can\'t enqueue block. Block height: 102, Queue last height: 100'
      );
    });

    // it('should throw error when queue is full', async () => {
    //   // First, fill the queue to capacity
    //   const block1 = createMockBlock(101, { size: 9000 });
    //   await queue.enqueue(block1);
      
    //   // Try to add another block that would exceed capacity
    //   const block2 = createMockBlock(102, { size: 2000 });
    //   await expect(queue.enqueue(block2)).rejects.toThrow(
    //     /Can't enqueue block. isQueueFull: true/
    //   );
    // });

    it('should throw error when max height is reached', async () => {
      const queueAtMaxHeight = new BlocksQueue<Block>({
        ...defaultOptions,
        lastHeight: 200
      });
      
      const block = createMockBlock(201);
      await expect(queueAtMaxHeight.enqueue(block)).rejects.toThrow(
        /isMaxHeightReached: true/
      );
    });

    it('should handle blocks with withdrawals (Shanghai fork)', async () => {
      const block = createMockBlock(101, {
        withdrawals: [
          {
            index: '0x1',
            validatorIndex: '0x100',
            address: '0x1234567890123456789012345678901234567890',
            amount: '0x1000'
          }
        ],
        withdrawalsRoot: '0xwithdrawals' + '0'.repeat(53),
        size: 500
      });
      
      await queue.enqueue(block);
      
      expect(queue.length).toBe(1);
      expect(block.withdrawals).toBeDefined();
    });

    it('should handle blocks with blob gas fields (Cancun fork)', async () => {
      const block = createMockBlock(101, {
        blobGasUsed: '0x1000',
        excessBlobGas: '0x2000',
        parentBeaconBlockRoot: '0xbeacon' + '0'.repeat(58),
        size: 500
      });
      
      await queue.enqueue(block);
      
      expect(queue.length).toBe(1);
      expect(block.blobGasUsed).toBe('0x1000');
    });
  });

  describe('Block Retrieval', () => {
    function createMockBlock(blockNumber: number, overrides: Partial<Block> = {}): Block {
      return {
        blockNumber,
        hash: '0xblock' + blockNumber.toString().padStart(60, '0'),
        parentHash: '0xparent' + '0'.repeat(58),
        nonce: '0x0000000000000042',
        sha3Uncles: '0xuncles' + '0'.repeat(58),
        logsBloom: '0x' + '0'.repeat(512),
        transactionsRoot: '0xtxroot' + '0'.repeat(57),
        stateRoot: '0xstate' + '0'.repeat(59),
        receiptsRoot: '0xreceipts' + '0'.repeat(55),
        miner: '0xminer' + '0'.repeat(54),
        difficulty: '1000000',
        totalDifficulty: '2000000',
        extraData: '0x',
        size: 1000,
        gasLimit: 8000000,
        gasUsed: 21000,
        timestamp: Date.now(),
        uncles: [],
        transactions: [],
        ...overrides
      };
    }

    it('firstBlock should return undefined for empty queue', async () => {
      const first = await queue.firstBlock();
      expect(first).toBeUndefined();
    });

    it('firstBlock should return the first block when queue has blocks', async () => {
      const block1 = createMockBlock(101, { size: 500 });
      const block2 = createMockBlock(102, { size: 500 });
      
      await queue.enqueue(block1);
      await queue.enqueue(block2);
      
      const first = await queue.firstBlock();
      expect(first?.blockNumber).toBe(101);
    });

    it('fetchBlockFromInStack should find block by height', async () => {
      const block1 = createMockBlock(101, { size: 500 });
      const block2 = createMockBlock(102, { size: 500 });
      
      await queue.enqueue(block1);
      await queue.enqueue(block2);
      
      const found = queue.fetchBlockFromInStack(102);
      expect(found?.blockNumber).toBe(102);
      
      const notFound = queue.fetchBlockFromInStack(999);
      expect(notFound).toBeUndefined();
    });

    it('fetchBlockFromOutStack should find block by height', async () => {
      const block1 = createMockBlock(101, { size: 500 });
      await queue.enqueue(block1);
      
      // This will trigger transferItems which moves blocks to outStack
      await queue.firstBlock();
      
      const found = await queue.fetchBlockFromOutStack(101);
      expect(found?.blockNumber).toBe(101);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    function createMockBlock(blockNumber: number, overrides: Partial<Block> = {}): Block {
      return {
        blockNumber,
        hash: '0xblock' + blockNumber.toString().padStart(60, '0'),
        parentHash: '0xparent' + '0'.repeat(58),
        nonce: '0x0000000000000042',
        sha3Uncles: '0xuncles' + '0'.repeat(58),
        logsBloom: '0x' + '0'.repeat(512),
        transactionsRoot: '0xtxroot' + '0'.repeat(57),
        stateRoot: '0xstate' + '0'.repeat(59),
        receiptsRoot: '0xreceipts' + '0'.repeat(55),
        miner: '0xminer' + '0'.repeat(54),
        difficulty: '1000000',
        totalDifficulty: '2000000',
        extraData: '0x',
        size: 1000,
        gasLimit: 8000000,
        gasUsed: 21000,
        timestamp: Date.now(),
        uncles: [],
        transactions: [],
        ...overrides
      };
    }

    it('should handle empty transactions array', async () => {
      const block = createMockBlock(101, { transactions: [] });
      
      await queue.enqueue(block);
      
      expect(queue.length).toBe(1);
      expect(queue.currentSize).toBeGreaterThan(0); // Should still have header size
    });

    it('should handle block with extraData', async () => {
      const block = createMockBlock(101, {
        extraData: '0x' + 'a'.repeat(64) // 32 bytes of extra data
      });
      
      await queue.enqueue(block);
      
      expect(queue.currentSize).toBeGreaterThan(32);
    });

    it('should handle concurrent enqueue operations', async () => {
      const block1 = createMockBlock(101, { size: 500 });
      const block2 = createMockBlock(102, { size: 500 });
      
      // These should be executed sequentially due to mutex
      const promises = [
        queue.enqueue(block1),
        queue.enqueue(block2)
      ];
      
      await Promise.all(promises);
      
      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(102);
    });

    it('should handle very large block numbers', async () => {
      const largeNumberQueue = new BlocksQueue<Block>({
        lastHeight: Number.MAX_SAFE_INTEGER - 1,
        maxQueueSize: 10000,
        blockSize: 1000,
        maxBlockHeight: Number.MAX_SAFE_INTEGER
      });
      
      const block = createMockBlock(Number.MAX_SAFE_INTEGER, { size: 500 });
      
      await largeNumberQueue.enqueue(block);
      
      expect(largeNumberQueue.lastHeight).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});