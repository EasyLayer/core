// import _ from 'lodash';
import { BlocksQueue } from '../blocks-queue';
import { Block, Transaction } from '../interfaces';

/**
 * A test implementation of the Block interface for testing purposes.
 */
class TestBlock implements Block {
  height: number;
  hash: string;
  tx: Transaction[];
  size: number;

  constructor(height: number, tx: Transaction[] = []) {
    this.height = height;
    this.hash = `hash${height}`;
    this.tx = tx;
    // Calculate the total size of the block based on its transactions
    this.size = tx.reduce((acc, transaction) => acc + transaction.size, 0);
  }
}

/**
 * Helper function to create a transaction with all required properties.
 *
 * @param hexSize - The size of the hex string in bytes.
 * @returns A Transaction object with all required properties.
 */
function createTransaction(hexSize: number): Transaction {
  return {
    txid: `txid${hexSize}`, // Mock txid
    hash: `hash${hexSize}`, // Mock hash
    vin: [], // Mock vin array; populate with mock data if necessary
    vout: [], // Mock vout array; populate with mock data if necessary
    hex: 'a'.repeat(hexSize * 2), // Each byte is represented by two hex characters
    size: hexSize, // Explicitly set size for clarity
    // Add other properties if necessary
  };
}

describe('BlocksQueue', () => {
  let queue: BlocksQueue<TestBlock>;

  beforeEach(() => {
    // Initialize the queue with lastHeight = -1
    queue = new BlocksQueue<TestBlock>(-1);
    // Set minTransferSize to 50 bytes for testing purposes
    queue.minTransferSize = 50;
  });

  describe('Initialization', () => {
    it('should initialize with an empty queue', () => {
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
      expect(queue.minTransferSize).toBe(50); // Confirm minTransferSize is set correctly
    });
  });

  describe('Enqueue Operation', () => {
    it('should enqueue a block with the correct height and valid transactions', async () => {
      const tx = [createTransaction(100)]; // 100 bytes
      const block = new TestBlock(0, tx);
      await queue.enqueue(block);

      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(0);
      expect(queue.currentSize).toBe(100);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should throw an error when enqueueing a block with an incorrect height', async () => {
      const tx = [createTransaction(100)];
      const block = new TestBlock(1, tx); // Incorrect height; should be 0

      await expect(queue.enqueue(block)).rejects.toThrow(`Can't enqueue block. Block height: 1, Queue last height: -1`);

      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
    });

    it('should enqueue multiple blocks with correct heights and valid transactions', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);
      const block3 = new TestBlock(2, [createTransaction(200)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.enqueue(block3);

      expect(queue.length).toBe(3);
      expect(queue.lastHeight).toBe(2);
      expect(queue.currentSize).toBe(450);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should throw an error when enqueueing a block if maxBlockHeight is reached', async () => {
      // Set maxBlockHeight to 1
      queue.maxBlockHeight = 1;

      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);
      // const block3 = new TestBlock(2, [createTransaction(100)]); // Exceeds maxBlockHeight

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(1);
      expect(queue.currentSize).toBe(250);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(true);
    });
  });

  describe('Dequeue Operation', () => {
    it('should dequeue a block correctly and update the queue state', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      // Trigger transferItems by calling firstBlock
      await queue.firstBlock();

      const dequeuedBlock1 = await queue.dequeue(block1.hash);
      expect(dequeuedBlock1).toEqual({
        height: 0,
        hash: 'hash0',
        tx: [
          {
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 100,
          },
        ],
        size: 100,
      });
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(1);
      expect(queue.currentSize).toBe(150);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);

      const dequeuedBlock2 = await queue.dequeue(block2.hash);
      expect(dequeuedBlock2).toEqual({
        height: 1,
        hash: 'hash1',
        tx: [
          {
            txid: 'txid150',
            hash: 'hash150',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 150,
          },
        ],
        size: 150,
      });
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(1); // Last height remains unchanged after dequeuing
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should throw an error when dequeuing unknown block', async () => {
      await expect(queue.dequeue('123')).rejects.toThrow(`Block not found or hash mismatch: 123, undefined`);
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });
  });

  describe('Clear Operation', () => {
    it('should clear the queue correctly', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      queue.clear();

      expect(queue.length).toBe(0);
      expect(queue.currentSize).toBe(0);
      expect(queue.lastHeight).toBe(1); // Last height remains as per implementation
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });
  });

  describe('Reorganize Operation', () => {
    it('should reorganize the queue correctly', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);
      await queue.enqueue(block1);
      await queue.enqueue(block2);

      await queue.reorganize(0);

      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(0);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });
  });

  describe('Fetch Block by Height', () => {
    it('should fetch a block by height from inStack using binary search', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      const fetchedBlock = queue.fetchBlockFromInStack(0);
      expect(fetchedBlock).toEqual({
        height: 0,
        hash: 'hash0',
        tx: [
          {
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 100,
          },
        ],
        size: 100,
      });
    });

    it('should return undefined if a block is not found in inStack using binary search', async () => {
      const block = new TestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block);

      const result = queue.fetchBlockFromInStack(1);
      expect(result).toBeUndefined();
    });

    it('should fetch a block by height from outStack using binary search', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.firstBlock(); // Trigger transferItems

      const result = await queue.fetchBlockFromOutStack(0);
      expect(result).toEqual({
        height: 0,
        hash: 'hash0',
        tx: [
          {
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 100,
          },
        ],
        size: 100,
      });
    });

    it('should return undefined if a block is not found in outStack using binary search', async () => {
      const block = new TestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block);
      await queue.firstBlock(); // Trigger transferItems

      const result = await queue.fetchBlockFromOutStack(1);
      expect(result).toBeUndefined();
    });
  });

  describe('Find Blocks by Hash', () => {
    it('should find blocks by hash correctly', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      const block2 = new TestBlock(1, [createTransaction(150)]);
      const block3 = new TestBlock(2, [createTransaction(200)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.enqueue(block3);

      // Trigger transferItems
      await queue.firstBlock();

      const foundBlocks = await queue.findBlocks(new Set(['hash0', 'hash2']));
      expect(foundBlocks).toContainEqual({
        height: 0,
        hash: 'hash0',
        tx: [
          {
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 100,
          },
        ],
        size: 100,
      });
      expect(foundBlocks).toContainEqual({
        height: 2,
        hash: 'hash2',
        tx: [
          {
            txid: 'txid200',
            hash: 'hash200',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 200,
          },
        ],
        size: 200,
      });
    });

    it('should return an empty array when finding blocks with non-existent hashes', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block1);

      // Trigger transferItems
      await queue.firstBlock();

      const foundBlocks = await queue.findBlocks(new Set(['hash1']));
      expect(foundBlocks).toEqual([]);
    });
  });

  describe('Get Batch Up To Size', () => {
    it('should return at least one block even when the first block exceeds maxSize in getBatchUpToSize', async () => {
      // Set maxQueueSize to 500 bytes
      queue.maxQueueSize = 500;

      // Enqueue a valid block within the limit
      const validBlock = new TestBlock(0, [createTransaction(400)]); // 400 bytes
      await queue.enqueue(validBlock);

      // Trigger transferItems to move blocks to outStack
      await queue.firstBlock();

      // Attempt to get a batch with maxSize 300, which is less than the size of the block
      const batch = await queue.getBatchUpToSize(300);

      // Ensure at least one block is returned, even though its size exceeds maxSize
      expect(batch.length).toBe(1);
      expect(batch[0].size).toBe(400); // The block should be oversizedBlock, which is 400 bytes
    });

    it('should return an empty array when the queue is empty', async () => {
      const batch = await queue.getBatchUpToSize(500);
      expect(batch).toEqual([]);
    });

    it('should return the correct batch when multiple blocks fit within maxSize', async () => {
      const block1 = new TestBlock(0, [createTransaction(100)]); // 100 bytes
      const block2 = new TestBlock(1, [createTransaction(150)]); // 150 bytes
      const block3 = new TestBlock(2, [createTransaction(200)]); // 200 bytes

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.enqueue(block3);

      // Trigger transferItems
      await queue.firstBlock();

      const batch = await queue.getBatchUpToSize(300); // Should include block1 and block2
      expect(batch).toContainEqual({
        height: 0,
        hash: 'hash0',
        tx: [
          {
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 100,
          },
        ],
        size: 100,
      });
      expect(batch).toContainEqual({
        height: 1,
        hash: 'hash1',
        tx: [
          {
            txid: 'txid150',
            hash: 'hash150',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 150,
          },
        ],
        size: 150,
      });
      expect(batch.length).toBe(2);
      expect(batch).not.toContainEqual({
        height: 2,
        hash: 'hash2',
        tx: [
          {
            txid: 'txid200',
            hash: 'hash200',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 200,
          },
        ],
        size: 200,
      });
    });

    it('should include a single block if it exactly matches maxSize', async () => {
      const block1 = new TestBlock(0, [createTransaction(300)]); // 300 bytes

      await queue.enqueue(block1);

      // Trigger transferItems
      await queue.firstBlock();

      const batch = await queue.getBatchUpToSize(300); // Should include block1
      expect(batch).toContainEqual({
        height: 0,
        hash: 'hash0',
        tx: [
          {
            txid: 'txid300',
            hash: 'hash300',
            vin: [],
            vout: [],
            hex: undefined, // hex was removed
            witness: undefined,
            size: 300,
          },
        ],
        size: 300,
      });
      expect(batch.length).toBe(1);
    });
  });
});
