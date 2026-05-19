import { BlocksQueue } from '../blocks-queue';
import { setEvmNativeBindings } from '../../native';
import { encodeEvmBlockPayload } from '../../blockchain-provider/codecs/block-payload-codec';
import type { RawBlock } from '../interfaces';

function createRawBlock(blockNumber: number, sizeBytes = 1000, hashSuffix = ''): RawBlock {
  const hash = `0x${'a'.repeat(63 - String(blockNumber).length)}${blockNumber}${hashSuffix}`;
  const block = {
    hash,
    blockNumber,
    parentHash: '0x' + '0'.repeat(64),
    size: sizeBytes,
    sizeWithoutReceipts: sizeBytes,
    transactions: [],
  };
  const bytes = encodeEvmBlockPayload(block as any);
  return { hash, height: blockNumber, size: sizeBytes, bytes };
}

describe('BlocksQueue', () => {
  afterEach(() => {
    setEvmNativeBindings(undefined);
  });
  const defaultOpts = {
    lastHeight: -1,
    maxQueueSize: 10 * 1024 * 1024,
    blockSize: 1000,
    maxBlockHeight: Number.MAX_SAFE_INTEGER,
  };

  describe('enqueue()', () => {
    it('enqueues RawBlock and updates lastHeight', async () => {
      const queue = new BlocksQueue(defaultOpts);
      await queue.enqueue(createRawBlock(0));
      expect(queue.lastHeight).toBe(0);
    });

    it('enqueues multiple sequential blocks', async () => {
      const queue = new BlocksQueue(defaultOpts);
      for (let i = 0; i < 5; i++) await queue.enqueue(createRawBlock(i));
      expect(queue.lastHeight).toBe(4);
    });

    it('throws when block is not sequential', async () => {
      const queue = new BlocksQueue(defaultOpts);
      await queue.enqueue(createRawBlock(0));
      await expect(queue.enqueue(createRawBlock(5))).rejects.toThrow();
    });

    it('throws when maxBlockHeight is reached', async () => {
      const queue = new BlocksQueue({ ...defaultOpts, maxBlockHeight: 2 });
      await queue.enqueue(createRawBlock(0));
      await queue.enqueue(createRawBlock(1));
      await queue.enqueue(createRawBlock(2));
      await expect(queue.enqueue(createRawBlock(3))).rejects.toThrow();
    });

    it('throws when would exceed maxQueueSize', async () => {
      const raw0 = createRawBlock(0, 900);
      const raw1 = createRawBlock(1, 900);
      const raw2 = createRawBlock(2, 900);
      const tinyQueue = new BlocksQueue({ ...defaultOpts, maxQueueSize: raw0.size + raw1.size + 1 });
      await tinyQueue.enqueue(raw0);
      await tinyQueue.enqueue(raw1);
      await expect(tinyQueue.enqueue(raw2)).rejects.toThrow();
    });

    it('accepts one oversized block when the queue is empty', async () => {
      const oversized = createRawBlock(0, 2);
      const queue = new BlocksQueue({ ...defaultOpts, maxQueueSize: 1, blockSize: 1 });

      expect(queue.isQueueOverloaded(oversized.size)).toBe(false);
      await queue.enqueue(oversized);

      expect(queue.length).toBe(1);
      expect(queue.currentSize).toBe(oversized.size);
      expect(queue.isQueueFull).toBe(true);
      expect(await queue.getBatchUpToSize(1)).toEqual([oversized]);
    });

    it('rejects additional blocks when the queue is non-empty and the memory budget would be exceeded', async () => {
      const queue = new BlocksQueue({ ...defaultOpts, maxQueueSize: 1, blockSize: 1 });

      await queue.enqueue(createRawBlock(0, 2));

      expect(queue.isQueueOverloaded(1)).toBe(true);
      await expect(queue.enqueue(createRawBlock(1, 1))).rejects.toThrow('Would exceed memory limit');
    });
  });

  describe('dequeue()', () => {
    it('dequeues by hash array and returns lastHeight', async () => {
      const queue = new BlocksQueue(defaultOpts);
      const b0 = createRawBlock(0);
      const b1 = createRawBlock(1);
      await queue.enqueue(b0);
      await queue.enqueue(b1);
      const height = await queue.dequeue([b0.hash, b1.hash]);
      expect(height).toBe(1);
    });

    it('dequeues single block', async () => {
      const queue = new BlocksQueue(defaultOpts);
      const b = createRawBlock(0);
      await queue.enqueue(b);
      const height = await queue.dequeue(b.hash);
      expect(height).toBe(0);
    });
  });

  describe('getBatchUpToSize()', () => {
    it('returns RawBlock[] with bytes', async () => {
      const queue = new BlocksQueue(defaultOpts);
      await queue.enqueue(createRawBlock(0));
      const batch = await queue.getBatchUpToSize(10000);
      expect(batch.length).toBe(1);
      expect(Buffer.isBuffer(batch[0]!.bytes)).toBe(true);
    });

    it('returns at least one block even if it exceeds maxSize', async () => {
      const queue = new BlocksQueue(defaultOpts);
      await queue.enqueue(createRawBlock(0, 5000));
      const batch = await queue.getBatchUpToSize(100);
      expect(batch.length).toBeGreaterThanOrEqual(1);
    });

    it('respects size budget', async () => {
      const queue = new BlocksQueue(defaultOpts);
      for (let i = 0; i < 5; i++) await queue.enqueue(createRawBlock(i, 1000));
      const first = (await queue.getBatchUpToSize(100))[0]!;
      const budget = first.size * 2 + 10;
      const batch = await queue.getBatchUpToSize(budget);
      expect(batch.length).toBe(2);
    });
  });


    it('native getBatchUpToSize and findBlocks use shared raw block API directly', async () => {
      const raw = createRawBlock(0);
      const calls: string[] = [];

      class FakeNativeBlocksQueue {
        validateEnqueue() {}
        enqueueBytes() {}
        isQueueFull() { return false; }
        isQueueOverloaded() { return false; }
        getBlockSize() { return 1; }
        setBlockSize() {}
        isMaxHeightReached() { return false; }
        getMaxBlockHeight() { return Number.MAX_SAFE_INTEGER; }
        setMaxBlockHeight() {}
        getMaxQueueSize() { return 10 * 1024 * 1024; }
        setMaxQueueSize() {}
        getCurrentSize() { return raw.size; }
        getLength() { return 1; }
        getLastHeight() { return 0; }
        getBatchUpToSize(maxSize: number) { calls.push(`getBatch:${maxSize}`); return [raw]; }
        findBlocks(hashes: string[]) { calls.push(`find:${hashes.join(',')}`); return [raw]; }
        dequeue() { return 0; }
        clear() {}
        reorganize() {}
        dispose() {}
        getMemoryStats() { return { bufferAllocated: 1, blocksUsed: 1, bufferEfficiency: 1, avgBlockSize: raw.size, indexesSize: 2, memoryUsedBytes: raw.size }; }
      }

      setEvmNativeBindings({ NativeBlocksQueue: FakeNativeBlocksQueue as any });
      const queue = new BlocksQueue(defaultOpts);

      expect(await queue.getBatchUpToSize(1024)).toEqual([raw]);
      expect(await queue.findBlocks(new Set([raw.hash]))).toEqual([raw]);
      expect(calls).toEqual(['getBatch:1024', `find:${raw.hash}`]);
    });

  describe('findBlocks()', () => {
    it('finds blocks by hash set and returns RawBlock[]', async () => {
      const queue = new BlocksQueue(defaultOpts);
      const b0 = createRawBlock(0);
      const b1 = createRawBlock(1);
      await queue.enqueue(b0);
      await queue.enqueue(b1);
      const found = await queue.findBlocks(new Set([b0.hash]));
      expect(found).toHaveLength(1);
      expect(found[0]!.height).toBe(0);
      expect(Buffer.isBuffer(found[0]!.bytes)).toBe(true);
    });
  });

  describe('reorganize()', () => {
    it('resets queue to given height', async () => {
      const queue = new BlocksQueue(defaultOpts);
      for (let i = 0; i < 5; i++) await queue.enqueue(createRawBlock(i));
      await queue.reorganize(2);
      expect(queue.lastHeight).toBe(2);
      expect(queue.length).toBe(0);
    });
  });

  describe('flags', () => {
    it('isMaxHeightReached when lastHeight >= maxBlockHeight', async () => {
      const queue = new BlocksQueue({ ...defaultOpts, maxBlockHeight: 1 });
      await queue.enqueue(createRawBlock(0));
      expect(queue.isMaxHeightReached).toBe(false);
      await queue.enqueue(createRawBlock(1));
      expect(queue.isMaxHeightReached).toBe(true);
    });

    it('isQueueFull when size >= maxQueueSize', async () => {
      const b0 = createRawBlock(0, 800);
      const b1 = createRawBlock(1, 800);
      const tiny = new BlocksQueue({ ...defaultOpts, maxQueueSize: b0.size + b1.size });
      await tiny.enqueue(b0);
      expect(tiny.isQueueFull).toBe(false);
      await tiny.enqueue(b1);
      expect(tiny.isQueueFull).toBe(true);
    });
  });
});
