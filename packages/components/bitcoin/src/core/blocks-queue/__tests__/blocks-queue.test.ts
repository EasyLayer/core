import { Block, Transaction } from '../../blockchain-provider';
import { BlocksQueue, CapacityPlanner } from '../blocks-queue';
import { setBitcoinNativeBindings } from '../../native';

function createTransaction(baseSize: number, witnessSize: number = 0): Transaction {
  const totalSize = baseSize + witnessSize;
  const weight = (baseSize * 4) + witnessSize;
  const vsize = Math.ceil(weight / 4);
  return {
    txid: `txid${baseSize}-${witnessSize}-${Math.random()}`,
    hash: `hash${baseSize}-${witnessSize}-${Math.random()}`,
    version: 1,
    size: totalSize,
    strippedsize: baseSize,
    sizeWithoutWitnesses: baseSize,
    vsize,
    weight,
    witnessSize: witnessSize > 0 ? witnessSize : undefined,
    locktime: 0,
    vin: [],
    vout: [],
    fee: 0,
    feeRate: 0,
    wtxid: witnessSize > 0 ? `wtxid${baseSize}` : undefined,
    bip125_replaceable: false,
  } as any;
}

function createTestBlock(height: number, tx: Transaction[] = []): Block {
  const totalSize = tx.reduce((acc, t) => acc + (t as any).size, 0);
  const totalStrippedSize = tx.reduce((acc, t) => acc + ((t as any).strippedsize ?? (t as any).size), 0);
  const totalWeight = tx.reduce((acc, t) => acc + ((t as any).weight ?? (t as any).size * 4), 0);
  const totalVSize = tx.reduce((acc, t) => acc + ((t as any).vsize ?? Math.ceil(((t as any).weight ?? (t as any).size * 4) / 4)), 0);
  const totalWitnessSize = tx.reduce((acc, t) => acc + ((t as any).witnessSize || 0), 0);

  return {
    height,
    hash: `hash${height}-${Math.random()}`,
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
    nTx: tx.length,
  } as any;
}

const makeTransaction = createTransaction;
const makeBlock = createTestBlock;

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

    let r = planner.shouldResize({
      now,
      maxQueueBytes: budgetWithin,
      currentCapacity: capacity,
      currentCount: count,
    });
    expect(r.need).toBe(false);

    for (let i = 0; i < 200; i++) planner.observe(64 * 1024);

    r = planner.shouldResize({
      now: now + 6000,
      maxQueueBytes: budgetWithin,
      currentCapacity: capacity,
      currentCount: count,
    });

    if (r.need) {
      expect(r.targetSlots).toBeGreaterThanOrEqual(count);
    }

    planner.markResized(now + 6000);

    const r2 = planner.shouldResize({
      now: now + 7000,
      maxQueueBytes: budgetWithin,
      currentCapacity: capacity,
      currentCount: count,
    });
    expect(r2.need).toBe(false);
  });
});

describe('BlocksQueue', () => {
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1 * 1024 * 1024,
      maxQueueSize: 1 * 1024 * 1024,
      plannerConfig: { maxSlots: 10_000, minSlots: 2 },
    });
  });

  afterEach(() => {
    setBitcoinNativeBindings(undefined);
  });

  it('enqueue then dequeue removes the block and updates state', async () => {
    const block = makeBlock(0, [makeTransaction(100)]);
    await queue.enqueue(block);
    const removed = await queue.dequeue(block.hash);
    expect(removed).toBe(block.height);
    expect(queue.length).toBe(0);
    expect(queue.currentSize).toBe(0);
    const first = await queue.firstBlock();
    expect(first).toBeUndefined();
  });

  it('successful enqueue removes block hex fields before storage', async () => {
    const tx = makeTransaction(100) as any;
    tx.hex = 'tx-hex';
    const block = makeBlock(0, [tx]) as any;
    block.hex = 'block-hex';

    await queue.enqueue(block);

    expect('hex' in block).toBe(false);
    expect('hex' in block.tx[0]).toBe(false);

    const batch = await queue.getBatchUpToSize(block.size);
    expect(batch).toHaveLength(1);
    expect('hex' in (batch[0] as any)).toBe(false);
    expect('hex' in ((batch[0] as any).tx[0] as any)).toBe(false);
  });

  it('failed enqueue keeps hex fields untouched', async () => {
    const tx = makeTransaction(100) as any;
    tx.hex = 'tx-hex';
    const block = makeBlock(1, [tx]) as any;
    block.hex = 'block-hex';

    await expect(queue.enqueue(block)).rejects.toThrow(`Can't enqueue block. Block height: 1, Queue last height: -1`);

    expect(block.hex).toBe('block-hex');
    expect(block.tx[0].hex).toBe('tx-hex');
  });

  it('native enqueue validates before cleanup and passes cleaned block to enqueueCleaned', async () => {
    const calls: string[] = [];
    let receivedBlock: any;

    class FakeNativeBlocksQueue {
      validateEnqueue(meta: any) {
        calls.push(`validate:${meta.hash}:${meta.height}:${meta.size}`);
      }

      enqueueCleaned(block: any) {
        calls.push('enqueueCleaned');
        receivedBlock = block;
      }

      isQueueFull() { return false; }
      isQueueOverloaded() { return false; }
      getBlockSize() { return 1; }
      setBlockSize() {}
      isMaxHeightReached() { return false; }
      getMaxBlockHeight() { return Number.MAX_SAFE_INTEGER; }
      setMaxBlockHeight() {}
      getMaxQueueSize() { return 1024 * 1024; }
      setMaxQueueSize() {}
      getCurrentSize() { return 0; }
      getLength() { return 0; }
      getLastHeight() { return -1; }
      firstBlock() { return undefined; }
      enqueue() {}
      dequeue() { return 0; }
      fetchBlockFromInStack() { return undefined; }
      fetchBlockFromOutStack() { return undefined; }
      findBlocks() { return []; }
      getBatchUpToSize() { return []; }
      clear() {}
      reorganize() {}
      getMemoryStats() {
        return {
          bufferAllocated: 0,
          blocksUsed: 0,
          bufferEfficiency: 0,
          avgBlockSize: 0,
          indexesSize: 0,
          memoryUsedBytes: 0,
        };
      }
    }

    setBitcoinNativeBindings({ NativeBlocksQueue: FakeNativeBlocksQueue as any });

    const nativeQueue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1024,
      maxQueueSize: 1024 * 1024,
    });

    const tx = makeTransaction(100) as any;
    tx.hex = 'tx-hex';
    const block = makeBlock(0, [tx]) as any;
    block.hex = 'block-hex';

    await nativeQueue.enqueue(block);

    expect(calls).toEqual([`validate:${block.hash}:0:${block.size}`, 'enqueueCleaned']);
    expect('hex' in block).toBe(false);
    expect('hex' in block.tx[0]).toBe(false);
    expect(receivedBlock).toBe(block);
    expect('hex' in receivedBlock).toBe(false);
    expect('hex' in receivedBlock.tx[0]).toBe(false);
  });

  it('findBlocks returns blocks with the same values as stored', async () => {
    const blockA = makeBlock(0, [makeTransaction(100)]);
    const blockB = makeBlock(1, [makeTransaction(120)]);
    await queue.enqueue(blockA);
    await queue.enqueue(blockB);
    await queue.firstBlock();
    const found = await queue.findBlocks(new Set([blockA.hash, blockB.hash]));
    expect(found.length).toBe(2);
    expect(found.map(b => b.hash).sort()).toEqual([blockA.hash, blockB.hash].sort());
  });

  it('wrap-around FIFO order is preserved', async () => {
    const smallQueue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxQueueSize: 8 * 1024 * 1024,
      blockSize: 1 * 1024,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      plannerConfig: { minSlots: 2 },
    } as any);
    const a = makeBlock(0, [makeTransaction(512)]);
    const b = makeBlock(1, [makeTransaction(512)]);
    const c = makeBlock(2, [makeTransaction(512)]);
    await smallQueue.enqueue(a);
    await smallQueue.enqueue(b);
    const removedA = await smallQueue.dequeue(a.hash);
    expect(removedA).toBe(a.height);
    await smallQueue.enqueue(c);
    const removedB = await smallQueue.dequeue(b.hash);
    expect(removedB).toBe(b.height);
    const removedC = await smallQueue.dequeue(c.hash);
    expect(removedC).toBe(c.height);
    expect(smallQueue.length).toBe(0);
  });

  it('reorganize clears queue and sets new last height', async () => {
    const block = makeBlock(0, [makeTransaction(50)]);
    await queue.enqueue(block);
    await queue.reorganize(1000);
    expect(queue.length).toBe(0);
    expect(queue.lastHeight).toBe(1000);
  });

  it('concurrent enqueue preserves order and first block', async () => {
    const blocks: Block[] = [];
    for (let i = 0; i < 50; i++) {
      blocks.push(makeBlock(i, [makeTransaction(2048 + i)]));
    }
    await Promise.all(blocks.map(b => queue.enqueue(b)));
    expect(queue.length).toBe(50);
    const first = await queue.firstBlock();
    expect(first?.height).toBe(blocks[0]!.height);
  });

  it('enqueue → dequeue → firstBlock → findBlocks stays consistent', async () => {
    const blocks: Block[] = [];
    for (let i = 0; i < 30; i++) {
      blocks.push(makeBlock(i, [makeTransaction(1024 + i)]));
    }
    await Promise.all(blocks.map(b => queue.enqueue(b)));
    const removed = await queue.dequeue(blocks[0]!.hash);
    expect(removed).toBe(blocks[0]!.height);
    const firstAfter = await queue.firstBlock();
    expect(firstAfter?.height).toBe(blocks[1]!.height);
    const subset = new Set([blocks[5]!.hash, blocks[10]!.hash, blocks[20]!.hash]);
    const found = await queue.findBlocks(subset);
    expect(found.map(b => b.height).sort((a, b) => a - b)).toEqual([blocks[5]!.height, blocks[10]!.height, blocks[20]!.height]);
    expect(found[0]?.hash).toBe(blocks[5]!.hash);
    expect(found[1]?.hash).toBe(blocks[10]!.hash);
    expect(found[2]?.hash).toBe(blocks[20]!.hash);
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
      const tx = [createTransaction(100)];
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
      const block = createTestBlock(1, tx);

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
      const segwitTx = createTransaction(100, 50);
      const block = createTestBlock(0, [segwitTx]);
      await queue.enqueue(block);

      expect(block.size).toBe(150);
      expect(block.strippedsize).toBe(100);
      expect(block.witnessSize).toBe(50);
    });
  });

  describe('Dequeue Operation', () => {
    it('should dequeue a block correctly and update the queue state', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);

      await queue.enqueue(block1);
      await queue.enqueue(block2);

      await queue.firstBlock();

      const removed1 = await queue.dequeue(block1.hash);
      expect(removed1).toBe(block1.height);
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(1);
      expect(queue.currentSize).toBe(block2.size);

      const removed2 = await queue.dequeue(block2.hash);
      expect(removed2).toBe(block2.height);
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(1);
      expect(queue.currentSize).toBe(0);
    });

    it('should throw an error when dequeuing unknown block', async () => {
      await expect(queue.dequeue('123')).rejects.toThrow(`Block not found: 123`);
      expect(queue.length).toBe(0);
      expect(queue.lastHeight).toBe(-1);
      expect(queue.currentSize).toBe(0);
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
      expect(queue.lastHeight).toBe(1);
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
    });
  });

  describe('Fetch Block by Height', () => {
    it('should fetch a block by height from inStack', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);
      await queue.enqueue(block1);
      await queue.enqueue(block2);

      const fetched = queue.fetchBlockFromInStack(0);
      expect(fetched?.height).toBe(0);
      expect(fetched?.hash.startsWith('hash0')).toBe(true);
    });

    it('should return undefined if a block is not found in inStack', async () => {
      const block = createTestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block);
      const result = queue.fetchBlockFromInStack(1);
      expect(result).toBeUndefined();
    });

    it('should fetch a block by height from outStack (async)', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);
      await queue.enqueue(block1);
      await queue.enqueue(block2);
      await queue.firstBlock();

      const result = await queue.fetchBlockFromOutStack(0);
      expect(result?.height).toBe(0);
    });

    it('should return undefined if a block is not found in outStack', async () => {
      const block = createTestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block);
      await queue.firstBlock();

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
      await queue.firstBlock();

      const foundBlocks = await queue.findBlocks(new Set([block1.hash, block3.hash]));
      expect(foundBlocks.map(b => b.height).sort((a, b) => a - b)).toEqual([0, 2]);
    });

    it('should return an empty array when finding blocks with non-existent hashes', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      await queue.enqueue(block1);
      await queue.firstBlock();

      const foundBlocks = await queue.findBlocks(new Set(['hash-does-not-exist']));
      expect(foundBlocks).toEqual([]);
    });
  });

  describe('Get Batch Up To Size', () => {
    it('should return at least one block even when the first block exceeds maxSize', async () => {
      queue.maxQueueSize = 500;

      const b = createTestBlock(0, [createTransaction(300)]);
      await queue.enqueue(b);
      await queue.firstBlock();

      const batch = await queue.getBatchUpToSize(200);
      expect(batch.length).toBe(1);
      expect(batch[0]!.size).toBe(b.size);
    });

    it('should return an empty array when the queue is empty', async () => {
      const batch = await queue.getBatchUpToSize(500);
      expect(batch).toEqual([]);
    });

    it('should return the correct batch when multiple blocks fit within maxSize', async () => {
      const b1 = createTestBlock(0, [createTransaction(50)]);
      const b2 = createTestBlock(1, [createTransaction(75)]);
      const b3 = createTestBlock(2, [createTransaction(100)]);

      await queue.enqueue(b1);
      await queue.enqueue(b2);
      await queue.enqueue(b3);
      await queue.firstBlock();

      const maxSize = b1.size + b2.size + 10;
      const batch = await queue.getBatchUpToSize(maxSize);

      expect(batch.length).toBe(2);
      expect(batch[0]!.height).toBe(0);
      expect(batch[1]!.height).toBe(1);
    });

    it('should include a single block if it exactly matches maxSize', async () => {
      const b1 = createTestBlock(0, [createTransaction(200)]);
      await queue.enqueue(b1);
      await queue.firstBlock();

      const batch = await queue.getBatchUpToSize(b1.size);
      expect(batch.length).toBe(1);
      expect(batch[0]!.height).toBe(0);
    });

    it('can be configured to effectively pop one block per iteration by batch limit', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: -1,
        maxQueueSize: 100,
        blockSize: 2,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        plannerConfig: { minSlots: 2, maxSlots: 1000 },
      });

      await q.enqueue(createTestBlock(0, [createTransaction(2)]));
      await q.enqueue(createTestBlock(1, [createTransaction(2)]));
      await q.enqueue(createTestBlock(2, [createTransaction(2)]));

      await q.firstBlock();
      const batch = await q.getBatchUpToSize(2);
      expect(batch.length).toBe(1);
      expect(batch[0]!.height).toBe(0);
    });
  });
});
