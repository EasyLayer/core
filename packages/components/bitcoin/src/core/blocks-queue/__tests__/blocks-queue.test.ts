import { BlocksQueue, CapacityPlanner } from '../blocks-queue';
import { setBitcoinNativeBindings } from '../../native';
import type { RawBlock } from '../interfaces';

function createRawBlock(height: number, size = 1000, hashSuffix = ''): RawBlock {
  return {
    hash: `hash${height}${hashSuffix}-${Math.random()}`,
    height,
    size,
    bytes: Buffer.alloc(size),
  };
}

describe('CapacityPlanner', () => {
  it('computes desiredSlots under budget and reacts to EMA', () => {
    const planner = new CapacityPlanner(1024, { maxSlots: 1_000, minSlots: 1 });
    const budget = 64 * 1024;

    const d0 = planner.desiredSlots(budget);
    expect(d0).toBeGreaterThan(0);

    for (let i = 0; i < 50; i++) planner.observe(8 * 1024);
    const d1 = planner.desiredSlots(budget);
    expect(d1).toBeLessThan(d0);

    for (let i = 0; i < 100; i++) planner.observe(256);
    const d2 = planner.desiredSlots(budget);
    expect(d2).toBeGreaterThan(d1);
  });

  it('shouldResize respects cooldown and thresholds; never shrinks below occupancy', () => {
    const ema = 2048;
    const capacity = 100;
    const count = 80;
    const budgetWithin = capacity * ema;
    const planner = new CapacityPlanner(ema, {
      growThreshold: 0.2,
      shrinkThreshold: 0.3,
      resizeCooldownMs: 5000,
      maxSlots: 10_000,
    });
    const now = Date.now();

    let r = planner.shouldResize({ now, maxQueueBytes: budgetWithin, currentCapacity: capacity, currentCount: count });
    expect(r.need).toBe(false);

    for (let i = 0; i < 200; i++) planner.observe(64 * 1024);

    r = planner.shouldResize({ now: now + 6000, maxQueueBytes: budgetWithin, currentCapacity: capacity, currentCount: count });
    if (r.need) {
      expect(r.targetSlots).toBeGreaterThanOrEqual(count);
    }

    planner.markResized(now + 6000);

    const r2 = planner.shouldResize({ now: now + 7000, maxQueueBytes: budgetWithin, currentCapacity: capacity, currentCount: count });
    expect(r2.need).toBe(false);
  });
});

describe('BlocksQueue', () => {
  let queue: BlocksQueue;

  beforeEach(() => {
    queue = new BlocksQueue({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1 * 1024 * 1024,
      maxQueueSize: 10 * 1024 * 1024,
      plannerConfig: { maxSlots: 10_000, minSlots: 2 },
    });
  });

  afterEach(() => {
    setBitcoinNativeBindings(undefined);
  });

  describe('Initialization', () => {
    it('initializes with empty state', () => {
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
      expect(queue.isQueueFull).toBe(false);
      expect(queue.isMaxHeightReached).toBe(false);
    });
  });

  describe('enqueue()', () => {
    it('enqueues a RawBlock and updates state', async () => {
      const raw = createRawBlock(0, 500);
      await queue.enqueue(raw);
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(0);
      expect(queue.currentSize).toBe(500);
    });

    it('throws on wrong height', async () => {
      const raw = createRawBlock(1, 100);
      await expect(queue.enqueue(raw)).rejects.toThrow(`Can't enqueue block. Block height: 1, Queue last height: -1`);
      expect(queue.length).toBe(0);
    });

    it('enqueues multiple sequential blocks', async () => {
      await queue.enqueue(createRawBlock(0, 100));
      await queue.enqueue(createRawBlock(1, 150));
      await queue.enqueue(createRawBlock(2, 200));
      expect(queue.length).toBe(3);
      expect(queue.lastHeight).toBe(2);
      expect(queue.currentSize).toBe(450);
    });

    it('sets isMaxHeightReached when max height exceeded', async () => {
      queue.maxBlockHeight = 1;
      await queue.enqueue(createRawBlock(0, 100));
      await queue.enqueue(createRawBlock(1, 100));
      expect(queue.isMaxHeightReached).toBe(true);
    });

    it('native path calls validateEnqueue then enqueueBytes', async () => {
      const calls: string[] = [];
      let receivedHash = '';
      let receivedBytes: Buffer | undefined;

      class FakeNativeBlocksQueue {
        validateEnqueue(meta: any) { calls.push(`validate:${meta.hash}:${meta.height}:${meta.size}`); }
        enqueueBytes(hash: string, _h: number, _s: number, bytes: Buffer) {
          calls.push('enqueueBytes');
          receivedHash = hash;
          receivedBytes = bytes;
        }
        isQueueFull() { return false; }
        isQueueOverloaded() { return false; }
        getBlockSize() { return 1; }
        setBlockSize() {}
        isMaxHeightReached() { return false; }
        getMaxBlockHeight() { return Number.MAX_SAFE_INTEGER; }
        setMaxBlockHeight() {}
        getMaxQueueSize() { return 10 * 1024 * 1024; }
        setMaxQueueSize() {}
        getCurrentSize() { return 0; }
        getLength() { return 0; }
        getLastHeight() { return -1; }
        getBatchUpToSize() { return []; }
        findBlocks() { return []; }
        dequeue() { return 0; }
        clear() {}
        reorganize() {}
        dispose() {}
        getMemoryStats() { return { bufferAllocated: 0, blocksUsed: 0, bufferEfficiency: 0, avgBlockSize: 0, indexesSize: 0, memoryUsedBytes: 0 }; }
      }

      setBitcoinNativeBindings({ NativeBlocksQueue: FakeNativeBlocksQueue as any });

      const nativeQueue = new BlocksQueue({
        lastHeight: -1,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 1024,
        maxQueueSize: 10 * 1024 * 1024,
      });

      const raw = createRawBlock(0, 200);
      await nativeQueue.enqueue(raw);

      expect(calls).toEqual([`validate:${raw.hash}:0:200`, 'enqueueBytes']);
      expect(receivedHash).toBe(raw.hash);
      expect(receivedBytes).toBe(raw.bytes);
    });
  });

  describe('dequeue()', () => {
    it('dequeues a block and updates state', async () => {
      const raw0 = createRawBlock(0, 100);
      const raw1 = createRawBlock(1, 150);
      await queue.enqueue(raw0);
      await queue.enqueue(raw1);

      const removed = await queue.dequeue(raw0.hash);
      expect(removed).toBe(0);
      expect(queue.length).toBe(1);
      expect(queue.currentSize).toBe(150);
    });

    it('throws on unknown hash', async () => {
      await expect(queue.dequeue('unknown')).rejects.toThrow('Block not found: unknown');
    });
  });

  describe('getBatchUpToSize()', () => {
    it('returns RawBlock[] with bytes intact', async () => {
      const raw = createRawBlock(0, 500);
      await queue.enqueue(raw);
      const batch = await queue.getBatchUpToSize(1000);
      expect(batch).toHaveLength(1);
      expect(batch[0]!.hash).toBe(raw.hash);
      expect(batch[0]!.height).toBe(0);
      expect(Buffer.isBuffer(batch[0]!.bytes)).toBe(true);
    });

    it('returns at least one block even when it exceeds maxSize', async () => {
      await queue.enqueue(createRawBlock(0, 1000));
      const batch = await queue.getBatchUpToSize(100);
      expect(batch.length).toBe(1);
    });

    it('returns empty array when queue is empty', async () => {
      const batch = await queue.getBatchUpToSize(1000);
      expect(batch).toEqual([]);
    });

    it('respects size budget and returns correct subset', async () => {
      await queue.enqueue(createRawBlock(0, 100));
      await queue.enqueue(createRawBlock(1, 100));
      await queue.enqueue(createRawBlock(2, 100));
      const batch = await queue.getBatchUpToSize(210);
      expect(batch.length).toBe(2);
      expect(batch[0]!.height).toBe(0);
      expect(batch[1]!.height).toBe(1);
    });
  });


    it('native getBatchUpToSize and findBlocks use shared raw block API directly', async () => {
      const bytes = Buffer.from([1, 2, 3]);
      const raw = { hash: 'native-hash', height: 0, size: bytes.length, bytes };
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
        getCurrentSize() { return bytes.length; }
        getLength() { return 1; }
        getLastHeight() { return 0; }
        getBatchUpToSize(maxSize: number) { calls.push(`getBatch:${maxSize}`); return [raw]; }
        findBlocks(hashes: string[]) { calls.push(`find:${hashes.join(',')}`); return [raw]; }
        dequeue() { return 0; }
        clear() {}
        reorganize() {}
        dispose() {}
        getMemoryStats() { return { bufferAllocated: 1, blocksUsed: 1, bufferEfficiency: 1, avgBlockSize: bytes.length, indexesSize: 2, memoryUsedBytes: bytes.length }; }
      }

      setBitcoinNativeBindings({ NativeBlocksQueue: FakeNativeBlocksQueue as any });
      const nativeQueue = new BlocksQueue({
        lastHeight: -1,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 1024,
        maxQueueSize: 10 * 1024 * 1024,
      });

      expect(await nativeQueue.getBatchUpToSize(1024)).toEqual([raw]);
      expect(await nativeQueue.findBlocks(new Set(['native-hash']))).toEqual([raw]);
      expect(calls).toEqual(['getBatch:1024', 'find:native-hash']);
    });

  describe('findBlocks()', () => {
    it('finds blocks by hash and returns RawBlock[]', async () => {
      const raw0 = createRawBlock(0, 100);
      const raw1 = createRawBlock(1, 100);
      await queue.enqueue(raw0);
      await queue.enqueue(raw1);
      const found = await queue.findBlocks(new Set([raw0.hash, raw1.hash]));
      expect(found.length).toBe(2);
      expect(found.map(b => b.hash).sort()).toEqual([raw0.hash, raw1.hash].sort());
    });

    it('returns empty array for unknown hashes', async () => {
      await queue.enqueue(createRawBlock(0, 100));
      const found = await queue.findBlocks(new Set(['nonexistent']));
      expect(found).toEqual([]);
    });
  });

  describe('clear()', () => {
    it('clears the queue but preserves lastHeight', async () => {
      await queue.enqueue(createRawBlock(0, 100));
      await queue.enqueue(createRawBlock(1, 100));
      queue.clear();
      expect(queue.length).toBe(0);
      expect(queue.currentSize).toBe(0);
      expect(queue.lastHeight).toBe(1);
    });
  });

  describe('reorganize()', () => {
    it('clears queue and sets new lastHeight', async () => {
      await queue.enqueue(createRawBlock(0, 100));
      await queue.reorganize(500);
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(500);
    });
  });

  describe('wrap-around FIFO order', () => {
    it('preserves FIFO order after wrap-around', async () => {
      const q = new BlocksQueue({
        lastHeight: -1,
        maxQueueSize: 8 * 1024 * 1024,
        blockSize: 1024,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        plannerConfig: { minSlots: 2 },
      } as any);
      const a = createRawBlock(0, 512);
      const b = createRawBlock(1, 512);
      const c = createRawBlock(2, 512);
      await q.enqueue(a);
      await q.enqueue(b);
      expect(await q.dequeue(a.hash)).toBe(0);
      await q.enqueue(c);
      expect(await q.dequeue(b.hash)).toBe(1);
      expect(await q.dequeue(c.hash)).toBe(2);
      expect(q.length).toBe(0);
    });
  });
});
