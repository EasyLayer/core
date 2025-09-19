import { Block, Transaction } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';

function makeTransaction(size: number, witnessSize: number = 0): Transaction {
  const baseSize = size;
  const strippedsize = baseSize;
  const weight = baseSize * 4 + witnessSize;
  const vsize = Math.ceil(weight / 4);
  return {
    txid: `tx-${size}-${witnessSize}-${Math.random()}`,
    hash: `hash-${size}-${witnessSize}-${Math.random()}`,
    size: baseSize + witnessSize,
    vsize,
    weight,
    strippedsize,
    locktime: 0,
    vin: [],
    vout: [],
  } as any;
}

function makeBlock(height: number, transactions: Transaction[]): Block {
  const totalSize = transactions.reduce((n, t) => n + (t as any).size, 0);
  const totalStrippedSize = transactions.reduce((n, t) => n + ((t as any).strippedsize ?? (t as any).size), 0);
  const totalWeight = transactions.reduce((n, t) => n + ((t as any).weight ?? (t as any).size * 4), 0);
  const totalVsize = transactions.reduce((n, t) => n + ((t as any).vsize ?? Math.ceil(((t as any).weight ?? (t as any).size * 4) / 4)), 0);
  return {
    height,
    hash: `block-${height}-${Math.random()}`,
    size: totalSize,
    strippedsize: totalStrippedSize,
    weight: totalWeight,
    vsize: totalVsize,
    tx: transactions as any,
    time: Date.now(),
  } as any;
}

describe('BlocksQueue reference identity and behavior', () => {
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxQueueSize: 64 * 1024 * 1024,
      blockSize: 256 * 1024,
      maxBlockHeight: Number.MAX_SAFE_INTEGER
    } as any);
  });

  it('enqueue then dequeue removes the block and updates state', async () => {
    const block = makeBlock(0, [makeTransaction(100)]);
    await queue.enqueue(block);
    const removed = await queue.dequeue(block.hash);
    expect(removed).toBe(1);
    expect(queue.length).toBe(0);
    expect(queue.currentSize).toBe(0);
    // firstBlock should now be undefined
    const first = await queue.firstBlock();
    expect(first).toBeUndefined();
  });

  it('findBlocks returns the same object references as stored', async () => {
    const blockA = makeBlock(0, [makeTransaction(100)]);
    const blockB = makeBlock(1, [makeTransaction(120)]);
    await queue.enqueue(blockA);
    await queue.enqueue(blockB);
    await queue.firstBlock();
    const found = await queue.findBlocks(new Set([blockA.hash, blockB.hash]));
    expect(found.length).toBe(2);
    expect(found.includes(blockA)).toBe(true);
    expect(found.includes(blockB)).toBe(true);
  });

  it('wrap-around FIFO order is preserved', async () => {
    const smallQueue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxQueueSize: 8 * 1024 * 1024,
      blockSize: 1 * 1024,
      maxBlockHeight: Number.MAX_SAFE_INTEGER
    } as any);
    const a = makeBlock(0, [makeTransaction(512)]);
    const b = makeBlock(1, [makeTransaction(512)]);
    const c = makeBlock(2, [makeTransaction(512)]);
    await smallQueue.enqueue(a);
    await smallQueue.enqueue(b);
    const removedA = await smallQueue.dequeue(a.hash);
    expect(removedA).toBe(1);
    await smallQueue.enqueue(c);
    const removedB = await smallQueue.dequeue(b.hash);
    expect(removedB).toBe(1);
    const removedC = await smallQueue.dequeue(c.hash);
    expect(removedC).toBe(1);
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
    expect(removed).toBe(1);
    const firstAfter = await queue.firstBlock();
    expect(firstAfter?.height).toBe(blocks[1]!.height);
    const subset = new Set([blocks[5]!.hash, blocks[10]!.hash, blocks[20]!.hash]);
    const found = await queue.findBlocks(subset);
    expect(found.map(b => b.height).sort((a, b) => a - b)).toEqual([blocks[5]!.height, blocks[10]!.height, blocks[20]!.height]);
    expect(found[0]).toBe(blocks[5]);
    expect(found[1]).toBe(blocks[10]);
    expect(found[2]).toBe(blocks[20]);
  });
});
