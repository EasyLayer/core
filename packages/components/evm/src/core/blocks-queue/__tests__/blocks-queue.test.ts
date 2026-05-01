import { BlocksQueue } from '../blocks-queue';
import type { Block } from '../../blockchain-provider/components/block.interfaces';

function createBlock(blockNumber: number, sizeBytes = 1000, hashSuffix?: string): Block {
  const hash = `0x${'a'.repeat(63 - String(blockNumber).length)}${blockNumber}${hashSuffix ?? ''}`;
  const parentHash = blockNumber === 0
    ? '0x' + '0'.repeat(64)
    : `0x${'a'.repeat(63 - String(blockNumber - 1).length)}${blockNumber - 1}`;

  return {
    hash,
    parentHash,
    blockNumber,
    nonce: '0x0',
    sha3Uncles: '0x' + '1'.repeat(64),
    logsBloom: '0x' + '0'.repeat(512),
    transactionsRoot: '0x' + 'b'.repeat(64),
    stateRoot: '0x' + 'c'.repeat(64),
    receiptsRoot: '0x' + 'd'.repeat(64),
    miner: '0x' + 'f'.repeat(40),
    difficulty: '0x1',
    totalDifficulty: '0x1',
    extraData: '0x',
    gasLimit: 30_000_000,
    gasUsed: 21_000,
    timestamp: 1_700_000_000 + blockNumber * 12,
    uncles: [],
    size: sizeBytes,
    sizeWithoutReceipts: sizeBytes,
    transactions: [],
  } as Block;
}

describe('BlocksQueue', () => {
  const defaultOpts = {
    lastHeight: -1,
    maxQueueSize: 10 * 1024 * 1024, // 10MB
    blockSize: 1000,
    maxBlockHeight: Number.MAX_SAFE_INTEGER,
  };

  describe('enqueue()', () => {
    it('enqueues block and updates lastHeight', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      await queue.enqueue(createBlock(0));
      expect(queue.lastHeight).toBe(0);
    });

    it('enqueues multiple sequential blocks', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      for (let i = 0; i < 5; i++) await queue.enqueue(createBlock(i));
      expect(queue.lastHeight).toBe(4);
    });

    it('throws when block is not sequential', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      await queue.enqueue(createBlock(0));
      await expect(queue.enqueue(createBlock(5))).rejects.toThrow();
    });

    it('throws when maxBlockHeight is reached', async () => {
      const queue = new BlocksQueue<Block>({ ...defaultOpts, maxBlockHeight: 2 });
      await queue.enqueue(createBlock(0));
      await queue.enqueue(createBlock(1));
      await queue.enqueue(createBlock(2));
      await expect(queue.enqueue(createBlock(3))).rejects.toThrow();
    });

    it('throws when would exceed maxQueueSize', async () => {
      const tinyQueue = new BlocksQueue<Block>({ ...defaultOpts, maxQueueSize: 2000 });
      await tinyQueue.enqueue(createBlock(0, 900));
      await tinyQueue.enqueue(createBlock(1, 900));
      await expect(tinyQueue.enqueue(createBlock(2, 900))).rejects.toThrow();
    });
  });

  describe('dequeue()', () => {
    it('dequeues by hash array and returns lastHeight', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      const b0 = createBlock(0);
      const b1 = createBlock(1);
      await queue.enqueue(b0);
      await queue.enqueue(b1);
      const height = await queue.dequeue([b0.hash, b1.hash]);
      expect(height).toBe(1);
    });

    it('dequeues single block', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      const b = createBlock(0);
      await queue.enqueue(b);
      const height = await queue.dequeue(b.hash);
      expect(height).toBe(0);
    });
  });

  describe('getBatchUpToSize()', () => {
    it('returns batch not exceeding maxSize bytes', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      for (let i = 0; i < 5; i++) await queue.enqueue(createBlock(i, 1000));
      const batch = await queue.getBatchUpToSize(2500);
      const totalSize = batch.reduce((s, b) => s + b.size, 0);
      expect(totalSize).toBeLessThanOrEqual(2500 + 1000); // allow one overage
    });

    it('returns at least one block even if it exceeds maxSize', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      await queue.enqueue(createBlock(0, 5000));
      const batch = await queue.getBatchUpToSize(1000);
      expect(batch.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reorganize()', () => {
    it('resets queue to given height', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      for (let i = 0; i < 5; i++) await queue.enqueue(createBlock(i));
      await queue.reorganize(2);
      expect(queue.lastHeight).toBe(2);
    });
  });

  describe('findBlocks()', () => {
    it('finds blocks by hash set', async () => {
      const queue = new BlocksQueue<Block>(defaultOpts);
      const b0 = createBlock(0);
      const b1 = createBlock(1);
      await queue.enqueue(b0);
      await queue.enqueue(b1);
      const found = await queue.findBlocks(new Set([b0.hash]));
      expect(found).toHaveLength(1);
      expect(found[0]!.blockNumber).toBe(0);
    });
  });

  describe('flags', () => {
    it('isMaxHeightReached is true when lastHeight >= maxBlockHeight', async () => {
      const queue = new BlocksQueue<Block>({ ...defaultOpts, maxBlockHeight: 1 });
      await queue.enqueue(createBlock(0));
      expect(queue.isMaxHeightReached).toBe(false);
      await queue.enqueue(createBlock(1));
      expect(queue.isMaxHeightReached).toBe(true);
    });

    it('isQueueFull when size >= maxQueueSize', async () => {
      const tiny = new BlocksQueue<Block>({ ...defaultOpts, maxQueueSize: 1600 });
      await tiny.enqueue(createBlock(0, 800));
      expect(tiny.isQueueFull).toBe(false);
      await tiny.enqueue(createBlock(1, 800));
      expect(tiny.currentSize).toBe(1600);
      expect(tiny.isQueueFull).toBe(true);
    });

    it('isQueueOverloaded(n) returns true when adding n bytes would overflow', async () => {
      const queue = new BlocksQueue<Block>({ ...defaultOpts, maxQueueSize: 2000 });
      await queue.enqueue(createBlock(0, 1500));
      expect(queue.isQueueOverloaded(600)).toBe(true);
      expect(queue.isQueueOverloaded(400)).toBe(false);
    });
  });
});
