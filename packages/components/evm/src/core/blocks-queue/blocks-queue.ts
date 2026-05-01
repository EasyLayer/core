import { Mutex } from 'async-mutex';
import type { Block } from '../blockchain-provider/components';
import { getEvmNativeBindings } from '../native';
import type { NativeBlocksQueue } from '../native';

export interface PlannerConfig {
  maxSlots?: number;
  minSlots?: number;
  minAvgBytes?: number;
  maxAvgBytes?: number;
  alpha?: number;
  growThreshold?: number;
  shrinkThreshold?: number;
  resizeCooldownMs?: number;
}

export class CapacityPlanner {
  private emaAvgSize: number;
  private lastResizeAt = 0;

  private readonly maxSlots: number;
  private readonly minSlots: number;
  private readonly minAvgBytes: number;
  private readonly maxAvgBytes: number;
  private readonly alpha: number;
  private readonly growThreshold: number;
  private readonly shrinkThreshold: number;
  private readonly resizeCooldownMs: number;

  constructor(initialAvgBytes: number, cfg: PlannerConfig = {}) {
    this.minSlots = cfg.minSlots ?? 1;
    this.maxSlots = cfg.maxSlots ?? 100_000;
    this.minAvgBytes = cfg.minAvgBytes ?? 512;
    this.maxAvgBytes = cfg.maxAvgBytes ?? 8 * 1024 * 1024;
    this.alpha = cfg.alpha ?? 0.05;
    this.growThreshold = cfg.growThreshold ?? 0.3;
    this.shrinkThreshold = cfg.shrinkThreshold ?? 0.4;
    this.resizeCooldownMs = cfg.resizeCooldownMs ?? 10_000;

    this.emaAvgSize = Math.max(this.minAvgBytes, Math.min(initialAvgBytes, this.maxAvgBytes));
  }

  observe(sampleBytes: number): void {
    const sample = Math.max(1, Math.min(sampleBytes, this.maxAvgBytes * 4));
    this.emaAvgSize = this.alpha * sample + (1 - this.alpha) * this.emaAvgSize;
    this.emaAvgSize = Math.max(this.minAvgBytes, Math.min(this.emaAvgSize, this.maxAvgBytes));
  }

  getAvg(): number {
    return this.emaAvgSize;
  }

  desiredSlots(maxQueueBytes: number): number {
    const raw = Math.floor(maxQueueBytes / Math.max(1, this.emaAvgSize));
    return Math.max(this.minSlots, Math.min(this.maxSlots, raw));
  }

  shouldResize(params: { now: number; maxQueueBytes: number; currentCapacity: number; currentCount: number }): {
    need: boolean;
    targetSlots: number;
  } {
    const { now, maxQueueBytes, currentCapacity, currentCount } = params;

    if (now - this.lastResizeAt < this.resizeCooldownMs) {
      return { need: false, targetSlots: currentCapacity };
    }

    const desired = this.desiredSlots(maxQueueBytes);
    const needGrow = desired > Math.floor(currentCapacity * (1 + this.growThreshold));
    const needShrink = desired < Math.ceil(currentCapacity * (1 - this.shrinkThreshold)) && desired >= currentCount;

    if (!needGrow && !needShrink) {
      return { need: false, targetSlots: currentCapacity };
    }

    return { need: true, targetSlots: Math.max(currentCount, desired) };
  }

  markResized(now: number): void {
    this.lastResizeAt = now;
  }
}

/**
 * BlocksQueue for EVM chains.
 *
 * The heavy queue can be backed by Rust N-API (`NativeBlocksQueue`) in Node.
 * Browser and test runtimes use the TypeScript fallback with identical behavior.
 * EVM-specific differences from Bitcoin:
 * - ordering field is `blockNumber`, not `height`;
 * - block size includes receipts/traces when those are attached by the provider;
 * - only synthetic/raw `hex` fields are removed, transaction calldata is preserved.
 */
export class BlocksQueue<T extends Block = Block> {
  private _lastHeight: number;
  private _maxQueueSize: number;
  private _blockSize: number;
  private _size = 0;
  private _maxBlockHeight: number;
  private readonly mutex = new Mutex();
  private native?: NativeBlocksQueue<T>;
  private planner: CapacityPlanner;

  private blocks: (T | null)[];
  private headIndex = 0;
  private tailIndex = 0;
  private currentBlockCount = 0;
  private blockNumberIndex: Map<number, number> = new Map();
  private hashIndex: Map<string, number> = new Map();

  constructor({
    lastHeight,
    maxQueueSize,
    blockSize,
    maxBlockHeight,
    plannerConfig,
  }: {
    lastHeight: number;
    maxQueueSize: number;
    blockSize: number;
    maxBlockHeight: number;
    plannerConfig?: PlannerConfig;
  }) {
    this._lastHeight = lastHeight;
    this._maxQueueSize = maxQueueSize;
    this._blockSize = blockSize;
    this._maxBlockHeight = maxBlockHeight;
    this.planner = new CapacityPlanner(this._blockSize, plannerConfig);

    const NativeBlocksQueue = getEvmNativeBindings()?.NativeBlocksQueue;
    if (NativeBlocksQueue) {
      try {
        this.native = new NativeBlocksQueue<T>({ lastHeight, maxQueueSize, blockSize, maxBlockHeight, plannerConfig });
        this.blocks = [];
        return;
      } catch {
        this.native = undefined;
      }
    }

    const initialSlots = Math.max(2, this.planner.desiredSlots(this._maxQueueSize));
    this.blocks = new Array(initialSlots).fill(null);
  }

  get isQueueFull(): boolean {
    if (this.native) return this.native.isQueueFull();
    return this._size >= this._maxQueueSize;
  }

  public isQueueOverloaded(additionalSize: number): boolean {
    if (this.native) return this.native.isQueueOverloaded(additionalSize);
    return this.currentSize + additionalSize > this.maxQueueSize;
  }

  public get blockSize(): number {
    if (this.native) return this.native.getBlockSize();
    return this._blockSize;
  }

  public set blockSize(size: number) {
    if (this.native) {
      this.native.setBlockSize(size);
      return;
    }
    this._blockSize = size;
  }

  get isMaxHeightReached(): boolean {
    if (this.native) return this.native.isMaxHeightReached();
    return this._lastHeight >= this._maxBlockHeight;
  }

  public get maxBlockHeight(): number {
    if (this.native) return this.native.getMaxBlockHeight();
    return this._maxBlockHeight;
  }

  public set maxBlockHeight(height: number) {
    if (this.native) {
      this.native.setMaxBlockHeight(height);
      return;
    }
    this._maxBlockHeight = height;
  }

  public get maxQueueSize(): number {
    if (this.native) return this.native.getMaxQueueSize();
    return this._maxQueueSize;
  }

  public set maxQueueSize(size: number) {
    if (this.native) {
      this.native.setMaxQueueSize(size);
      return;
    }
    this._maxQueueSize = size;
  }

  public get currentSize(): number {
    if (this.native) return this.native.getCurrentSize();
    return this._size;
  }

  public get length(): number {
    if (this.native) return this.native.getLength();
    return this.currentBlockCount;
  }

  public get lastHeight(): number {
    if (this.native) return this.native.getLastHeight();
    return this._lastHeight;
  }

  public async firstBlock(): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      if (this.native) return this.native.firstBlock();
      if (this.currentBlockCount === 0) return undefined;
      return this.blocks[this.headIndex] || undefined;
    });
  }

  public async enqueue(block: T): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.native) {
        this.native.validateEnqueue({
          hash: block.hash,
          blockNumber: Number(block.blockNumber),
          size: Number(block.size),
        });
        this.cleanupBlockHexData(block);
        this.native.enqueueCleaned(block);
        return;
      }

      if (this.hashIndex.has(block.hash)) {
        throw new Error('Duplicate block hash');
      }

      const totalBlockSize = Number(block.size);
      this.planner.observe(totalBlockSize);
      const decision = this.planner.shouldResize({
        now: Date.now(),
        maxQueueBytes: this._maxQueueSize,
        currentCapacity: this.blocks.length,
        currentCount: this.currentBlockCount,
      });
      if (decision.need) {
        this.resizeRing(decision.targetSlots);
        this.planner.markResized(Date.now());
      }

      if (Number(block.blockNumber) !== this._lastHeight + 1) {
        throw new Error(
          `Can't enqueue block. Block number: ${block.blockNumber}, Queue last height: ${this._lastHeight}`
        );
      }
      if (this.isMaxHeightReached) {
        throw new Error(`Can't enqueue block. Max height reached: ${this._maxBlockHeight}`);
      }

      if (this.currentBlockCount >= this.blocks.length) {
        const desired = this.planner.desiredSlots(this._maxQueueSize);
        const doubled = Math.min(this.blocks.length * 2, 100_000);
        const target = Math.max(this.currentBlockCount + 1, desired, doubled);
        if (target > this.blocks.length) {
          this.resizeRing(target);
          this.planner.markResized(Date.now());
        }
        if (this.currentBlockCount >= this.blocks.length) {
          throw new Error(`Queue ring buffer capacity exceeded: ${this.blocks.length}`);
        }
      }

      if (this._size + totalBlockSize > this._maxQueueSize) {
        throw new Error(
          `Can't enqueue block. Would exceed memory limit: ${this._size + totalBlockSize}/${this._maxQueueSize} bytes`
        );
      }

      this.cleanupBlockHexData(block);
      this.blocks[this.tailIndex] = block;
      this.blockNumberIndex.set(Number(block.blockNumber), this.tailIndex);
      this.hashIndex.set(block.hash, this.tailIndex);
      this.tailIndex = (this.tailIndex + 1) % this.blocks.length;
      this.currentBlockCount++;
      this._size += totalBlockSize;
      this._lastHeight = Number(block.blockNumber);
    });
  }

  public async dequeue(hashOrHashes: string | string[]): Promise<number> {
    const hashes = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];

    return this.mutex.runExclusive(() => {
      if (this.native) return this.native.dequeue(hashes);

      let height = 0;
      for (const hash of hashes) {
        const bufferIndex = this.hashIndex.get(hash);
        if (bufferIndex === undefined) throw new Error(`Block not found: ${hash}`);
        if (bufferIndex !== this.headIndex) throw new Error(`Block not at head of queue: ${hash}`);

        const block = this.blocks[this.headIndex];
        if (!block) throw new Error(`Block data corrupted: ${hash}`);

        this.blocks[this.headIndex] = null;
        this.blockNumberIndex.delete(Number(block.blockNumber));
        this.hashIndex.delete(block.hash);
        this.headIndex = (this.headIndex + 1) % this.blocks.length;
        this.currentBlockCount--;
        this._size -= Number(block.size);
        height = Number(block.blockNumber);
      }

      return height;
    });
  }

  public fetchBlockFromInStack(height: number): T | undefined {
    if (this.native) return this.native.fetchBlockFromInStack(height);
    const bufferIndex = this.blockNumberIndex.get(height);
    if (bufferIndex === undefined) return undefined;
    return this.blocks[bufferIndex] || undefined;
  }

  public fetchBlockFromOutStack(height: number): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      if (this.native) return this.native.fetchBlockFromOutStack(height);
      return this.fetchBlockFromInStack(height);
    });
  }

  public findBlocks(hashSet: Set<string>): Promise<T[]> {
    return this.mutex.runExclusive(async () => {
      if (this.native) return this.native.findBlocks(Array.from(hashSet));
      const out: T[] = [];
      for (const hash of hashSet) {
        const index = this.hashIndex.get(hash);
        if (index !== undefined) {
          const block = this.blocks[index];
          if (block) out.push(block);
        }
      }
      return out;
    });
  }

  public async getBatchUpToSize(maxSize: number): Promise<T[]> {
    return this.mutex.runExclusive(async () => {
      if (this.native) return this.native.getBatchUpToSize(maxSize);
      if (this.currentBlockCount === 0) return [];

      const batch: T[] = [];
      let accumulatedSize = 0;
      let currentIndex = this.headIndex;
      let processedCount = 0;

      while (processedCount < this.currentBlockCount) {
        const block = this.blocks[currentIndex];
        if (!block) {
          currentIndex = (currentIndex + 1) % this.blocks.length;
          processedCount++;
          continue;
        }

        const blockSize = Number(block.size);
        if (accumulatedSize + blockSize > maxSize) {
          if (batch.length === 0) batch.push(block);
          break;
        }

        batch.push(block);
        accumulatedSize += blockSize;
        currentIndex = (currentIndex + 1) % this.blocks.length;
        processedCount++;
      }

      return batch;
    });
  }

  public clear(): void {
    if (this.native) {
      this.native.clear();
      return;
    }
    this.headIndex = 0;
    this.tailIndex = 0;
    this.currentBlockCount = 0;
    this._size = 0;
    this.blocks.fill(null);
    this.blockNumberIndex.clear();
    this.hashIndex.clear();
  }

  public async reorganize(reorganizeHeight: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      if (this.native) {
        this.native.reorganize(reorganizeHeight);
        return;
      }
      this.clear();
      this._lastHeight = reorganizeHeight;
    });
  }

  public getMemoryStats(): {
    bufferAllocated: number;
    blocksUsed: number;
    bufferEfficiency: number;
    avgBlockSize: number;
    indexesSize: number;
    memoryUsedBytes: number;
  } {
    if (this.native) return this.native.getMemoryStats();
    const indexesSize = this.blockNumberIndex.size + this.hashIndex.size;
    return {
      bufferAllocated: this.blocks.length,
      blocksUsed: this.currentBlockCount,
      bufferEfficiency: this.blocks.length > 0 ? this.currentBlockCount / this.blocks.length : 0,
      avgBlockSize: this.currentBlockCount > 0 ? this._size / this.currentBlockCount : 0,
      indexesSize,
      memoryUsedBytes: this._size,
    };
  }

  public dispose(): void {
    if (this.native) {
      this.native.dispose();
      return;
    }
    this.headIndex = 0;
    this.tailIndex = 0;
    this.currentBlockCount = 0;
    this._size = 0;
    this.blocks = [];
    this.blockNumberIndex.clear();
    this.hashIndex.clear();
  }

  private cleanupBlockHexData(block: T): void {
    delete (block as any).hex;
    if (Array.isArray(block.transactions)) {
      for (const tx of block.transactions) delete (tx as any).hex;
    }
  }

  private resizeRing(newCapacity: number): void {
    if (newCapacity === this.blocks.length) return;
    const newBlocks: (T | null)[] = new Array(newCapacity).fill(null);
    this.blockNumberIndex.clear();
    this.hashIndex.clear();

    let currentIndex = this.headIndex;
    for (let i = 0; i < this.currentBlockCount; i++) {
      const block = this.blocks[currentIndex];
      if (block) {
        newBlocks[i] = block;
        this.blockNumberIndex.set(Number(block.blockNumber), i);
        this.hashIndex.set(block.hash, i);
      }
      currentIndex = (currentIndex + 1) % this.blocks.length;
    }

    this.blocks = newBlocks;
    this.headIndex = 0;
    this.tailIndex = this.currentBlockCount % this.blocks.length;
  }
}
