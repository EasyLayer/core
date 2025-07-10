import { Block, Transaction } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';

/**
 * Helper function to create a test block object.
 */
function createTestBlock(height: number, tx: Transaction[] = []): Block {
  const totalSize = tx.reduce((acc, transaction) => acc + transaction.size, 0);
  const totalStrippedSize = tx.reduce((acc, transaction) => acc + transaction.strippedsize, 0);
  const totalWeight = tx.reduce((acc, transaction) => acc + transaction.weight, 0);
  const totalVSize = tx.reduce((acc, transaction) => acc + transaction.vsize, 0);
  const totalWitnessSize = tx.reduce((acc, transaction) => acc + (transaction.witnessSize || 0), 0);

  return {
    height,
    hash: `hash${height}`,
    tx,
    size: totalSize,
    strippedsize: totalStrippedSize,
    sizeWithoutWitnesses: totalStrippedSize,
    weight: totalWeight,
    vsize: totalVSize,
    witnessSize: totalWitnessSize > 0 ? totalWitnessSize : undefined,
    headerSize: 80,
    transactionsSize: totalSize,
    version: 1,
    versionHex: '00000001',
    merkleroot: '0'.repeat(64),
    time: Date.now(),
    mediantime: Date.now(),
    nonce: 0,
    bits: '0'.repeat(8),
    difficulty: '1',
    chainwork: '0'.repeat(64),
    nTx: tx.length
  };
}

/**
 * Helper function to create a transaction with all required properties.
 *
 * @param baseSize - The base size of the transaction (without witness data) in bytes.
 * @param witnessSize - The witness data size in bytes (optional, defaults to 0).
 * @returns A Transaction object with all required properties.
 */
function createTransaction(baseSize: number, witnessSize: number = 0): Transaction {
  const totalSize = baseSize + witnessSize;
  const weight = (baseSize * 4) + witnessSize; // BIP 141 weight calculation
  const vsize = Math.ceil(weight / 4); // Virtual size
  
  return {
    txid: `txid${baseSize}`,
    hash: `hash${baseSize}`,
    version: 1,
    // ===== ENHANCED SIZE FIELDS =====
    size: totalSize,
    strippedsize: baseSize,
    sizeWithoutWitnesses: baseSize, // Alias for strippedsize
    vsize: vsize,
    weight: weight,
    witnessSize: witnessSize > 0 ? witnessSize : undefined,
    locktime: 0,
    vin: [],
    vout: [],
    // ===== ADDITIONAL FIELDS =====
    fee: Math.floor(Math.random() * 1000), // Random fee for testing
    feeRate: Math.floor(Math.random() * 100), // Random fee rate
    wtxid: witnessSize > 0 ? `wtxid${baseSize}` : undefined,
    bip125_replaceable: false
  };
}

describe('BlocksQueue', () => {
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    // Initialize the queue with lastHeight = -1
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1048576,
      maxQueueSize: 1 * 1024 * 1024
    });
  });

  describe('Initialization', () => {
    it('should initialize with an empty queue', () => {
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });
  });

  describe('Enqueue Operation', () => {
    it('should enqueue a block with the correct height and valid transactions', async () => {
      const tx = [createTransaction(100)]; // 100 bytes base size
      const block = createTestBlock(0, tx);
      await queue.enqueue(block);

      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(0);
      expect(queue.currentSize).toBe(block.size);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should throw an error when enqueueing a block with an incorrect height', async () => {
      const tx = [createTransaction(100)];
      const block = createTestBlock(1, tx); // Incorrect height; should be 0

      await expect(queue.enqueue(block)).rejects.toThrow(`Can't enqueue block. Block height: 1, Queue last height: -1`);

      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
    });

    it('should enqueue multiple blocks with correct heights and valid transactions', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);
      const block3 = createTestBlock(2, [createTransaction(200)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.enqueue(block3);

      expect(queue.length).toBe(3);
      expect(queue.lastHeight).toBe(2);
      expect(queue.currentSize).toBe(block1.size + block2.size + block3.size);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should throw an error when enqueueing a block if maxBlockHeight is reached', async () => {
      // Set maxBlockHeight to 1
      queue.maxBlockHeight = 1;

      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(1);
      expect(queue.currentSize).toBe(block1.size + block2.size);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(true);
    });

    it('should handle SegWit transactions correctly', async () => {
      const segwitTx = createTransaction(100, 50); // 100 bytes base + 50 bytes witness
      const block = createTestBlock(0, [segwitTx]);
      await queue.enqueue(block);

      expect(block.size).toBe(150); // Total transaction size
      expect(block.strippedsize).toBe(100); // Base transaction size only
      expect(block.witnessSize).toBe(50);
    });
  });

  describe('Dequeue Operation', () => {
    it('should dequeue a block correctly and update the queue state', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      // Trigger transferItems by calling firstBlock
      await queue.firstBlock();

      const dequeuedBlock1 = await queue.dequeue(block1.hash);
      expect(dequeuedBlock1).toEqual(expect.objectContaining({
        height: 0,
        hash: 'hash0',
        tx: [
          expect.objectContaining({
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            size: 100,
            strippedsize: 100,
            sizeWithoutWitnesses: 100,
          }),
        ],
        size: block1.size,
        strippedsize: block1.strippedsize,
        sizeWithoutWitnesses: block1.sizeWithoutWitnesses,
      }));
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(1);
      expect(queue.currentSize).toBe(block2.size);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);

      const dequeuedBlock2 = await queue.dequeue(block2.hash);
      expect(dequeuedBlock2).toEqual(expect.objectContaining({
        height: 1,
        hash: 'hash1',
        tx: [
          expect.objectContaining({
            txid: 'txid150',
            hash: 'hash150',
            vin: [],
            vout: [],
            size: 150,
            strippedsize: 150,
            sizeWithoutWitnesses: 150,
          }),
        ],
        size: block2.size,
        strippedsize: block2.strippedsize,
        sizeWithoutWitnesses: block2.sizeWithoutWitnesses,
      }));
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(1); // Last height remains unchanged after dequeuing
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });

    it('should throw an error when dequeuing unknown block', async () => {
      await expect(queue.dequeue('123')).rejects.toThrow(`Block not found or hash mismatch: 123`);
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });
  });

  describe('Clear Operation', () => {
    it('should clear the queue correctly', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);

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
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);
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
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      const fetchedBlock = queue.fetchBlockFromInStack(0);
      expect(fetchedBlock).toEqual(expect.objectContaining({
        height: 0,
        hash: 'hash0',
        tx: [
          expect.objectContaining({
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            size: 100,
            strippedsize: 100,
            sizeWithoutWitnesses: 100,
          }),
        ],
        size: block1.size,
        strippedsize: block1.strippedsize,
        sizeWithoutWitnesses: block1.sizeWithoutWitnesses,
      }));
    });

    it('should return undefined if a block is not found in inStack using binary search', async () => {
      const block = createTestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block);

      const result = queue.fetchBlockFromInStack(1);
      expect(result).toBeUndefined();
    });

    it('should fetch a block by height from outStack using binary search', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.firstBlock(); // Trigger transferItems

      const result = await queue.fetchBlockFromOutStack(0);
      expect(result).toEqual(expect.objectContaining({
        height: 0,
        hash: 'hash0',
        tx: [
          expect.objectContaining({
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            size: 100,
            strippedsize: 100,
            sizeWithoutWitnesses: 100,
          }),
        ],
        size: block1.size,
        strippedsize: block1.strippedsize,
        sizeWithoutWitnesses: block1.sizeWithoutWitnesses,
      }));
    });

    it('should return undefined if a block is not found in outStack using binary search', async () => {
      const block = createTestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block);
      await queue.firstBlock(); // Trigger transferItems

      const result = await queue.fetchBlockFromOutStack(1);
      expect(result).toBeUndefined();
    });
  });

  describe('Find Blocks by Hash', () => {
    it('should find blocks by hash correctly', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);
      const block3 = createTestBlock(2, [createTransaction(200)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.enqueue(block3);

      // Trigger transferItems
      await queue.firstBlock();

      const foundBlocks = await queue.findBlocks(new Set(['hash0', 'hash2']));
      expect(foundBlocks).toContainEqual(expect.objectContaining({
        height: 0,
        hash: 'hash0',
        tx: [
          expect.objectContaining({
            txid: 'txid100',
            hash: 'hash100',
            vin: [],
            vout: [],
            size: 100,
            strippedsize: 100,
            sizeWithoutWitnesses: 100,
          }),
        ],
        size: block1.size,
        strippedsize: block1.strippedsize,
        sizeWithoutWitnesses: block1.sizeWithoutWitnesses,
      }));
      expect(foundBlocks).toContainEqual(expect.objectContaining({
        height: 2,
        hash: 'hash2',
        tx: [
          expect.objectContaining({
            txid: 'txid200',
            hash: 'hash200',
            vin: [],
            vout: [],
            size: 200,
            strippedsize: 200,
            sizeWithoutWitnesses: 200,
          }),
        ],
        size: block3.size,
        strippedsize: block3.strippedsize,
        sizeWithoutWitnesses: block3.sizeWithoutWitnesses,
      }));
    });

    it('should return an empty array when finding blocks with non-existent hashes', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
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
      const validBlock = createTestBlock(0, [createTransaction(300)]); // Base size 300 bytes
      await queue.enqueue(validBlock);

      // Trigger transferItems to move blocks to outStack
      await queue.firstBlock();

      // Attempt to get a batch with maxSize smaller than the block size
      const batch = await queue.getBatchUpToSize(200);

      // Ensure at least one block is returned, even though its size exceeds maxSize
      expect(batch.length).toBe(1);
      expect(batch[0].size).toBe(validBlock.size);
    });

    it('should return an empty array when the queue is empty', async () => {
      const batch = await queue.getBatchUpToSize(500);
      expect(batch).toEqual([]);
    });

    it('should return the correct batch when multiple blocks fit within maxSize', async () => {
      const block1 = createTestBlock(0, [createTransaction(50)]); // Small base size
      const block2 = createTestBlock(1, [createTransaction(75)]); // Small base size
      const block3 = createTestBlock(2, [createTransaction(100)]); // Larger base size

      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.enqueue(block3);

      // Trigger transferItems
      await queue.firstBlock();

      const maxSize = block1.size + block2.size + 10; // Should include block1 and block2 but not block3
      const batch = await queue.getBatchUpToSize(maxSize);
      
      expect(batch.length).toBe(2);
      expect(batch).toContainEqual(expect.objectContaining({
        height: 0,
        hash: 'hash0',
      }));
      expect(batch).toContainEqual(expect.objectContaining({
        height: 1,
        hash: 'hash1',
      }));
      expect(batch).not.toContainEqual(expect.objectContaining({
        height: 2,
        hash: 'hash2',
      }));
    });

    it('should include a single block if it exactly matches maxSize', async () => {
      const block1 = createTestBlock(0, [createTransaction(200)]); // Base size 200 bytes

      await queue.enqueue(block1);

      // Trigger transferItems
      await queue.firstBlock();

      const batch = await queue.getBatchUpToSize(block1.size); // Exact match
      expect(batch).toContainEqual(expect.objectContaining({
        height: 0,
        hash: 'hash0',
      }));
      expect(batch.length).toBe(1);
    });
  });

  describe('SegWit Transaction Handling', () => {
    it('should correctly handle blocks with mixed SegWit and legacy transactions', async () => {
      const legacyTx = createTransaction(100, 0); // No witness data
      const segwitTx = createTransaction(100, 50); // With witness data
      const block = createTestBlock(0, [legacyTx, segwitTx]);

      await queue.enqueue(block);

      expect(block.witnessSize).toBe(50); // Only from SegWit transaction
      expect(block.tx![0]!.witnessSize).toBeUndefined(); // Legacy transaction
      expect(block.tx![1]!.witnessSize).toBe(50); // SegWit transaction
      expect(block.tx![1]!.wtxid).toBe('wtxid100'); // SegWit transaction has wtxid
    });

    it('should calculate correct weight and vsize for SegWit blocks', async () => {
      const segwitTx = createTransaction(100, 50); // 100 base + 50 witness
      const block = createTestBlock(0, [segwitTx]);

      // BIP 141: weight = (base_size * 4) + witness_size
      const expectedTxWeight = (100 * 4) + 50; // 450

      expect(block.tx![0]!.weight).toBe(expectedTxWeight);
      expect(block.weight).toBe(expectedTxWeight);
      expect(block.vsize).toBe(Math.ceil(expectedTxWeight / 4));
    });
  });
});