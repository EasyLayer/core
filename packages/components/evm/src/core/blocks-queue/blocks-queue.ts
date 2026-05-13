import { Mutex } from 'async-mutex';
import { getEvmNativeBindings } from '../native';
import type { RawBlock } from './interfaces';
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
    if (!needGrow && !needShrink) return { need: false, targetSlots: currentCapacity };
    return { need: true, targetSlots: Math.max(currentCount, desired) };
  }

  markResized(now: number): void {
    this.lastResizeAt = now;
  }
}

export class BlocksQueue<TBlock = RawBlock> {
  private _lastHeight: number;
  private _maxQueueSize: number;
  private _blockSize: number;
  private _size: number = 0;
  private _maxBlockHeight: number;
  private readonly mutex = new Mutex();
  private native?: NativeBlocksQueue;

  private blocks: (RawBlock | null)[];
  private headIndex: number = 0;
  private tailIndex: number = 0;
  private currentBlockCount: number = 0;
  private readonly heightIndex: Map<number, number> = new Map();
  private readonly hashIndex: Map<string, number> = new Map();
  private readonly planner: CapacityPlanner;

  public maxBlockHeight: number;
  public maxQueueSize: number;

  constructor(options: {
    lastHeight: number;
    maxQueueSize: number;
    blockSize?: number;
    maxBlockHeight?: number;
    plannerConfig?: PlannerConfig;
  }) {
    const {
      lastHeight,
      maxQueueSize,
      blockSize = 1 * 1024 * 1024,
      maxBlockHeight = Number.MAX_SAFE_INTEGER,
      plannerConfig,
    } = options;

    this._lastHeight = lastHeight;
    this._maxQueueSize = maxQueueSize;
    this._blockSize = blockSize;
    this._maxBlockHeight = maxBlockHeight;
    this.maxBlockHeight = maxBlockHeight;
    this.maxQueueSize = maxQueueSize;

    this.planner = new CapacityPlanner(blockSize, plannerConfig ?? {});

    const NativeBlocksQueueCtor = getEvmNativeBindings()?.NativeBlocksQueue;
    if (NativeBlocksQueueCtor) {
      try {
        this.native = new NativeBlocksQueueCtor({ lastHeight, maxQueueSize, blockSize, maxBlockHeight, plannerConfig });
        this.blocks = [];
        return;
      } catch {
        this.native = undefined;
      }
    }

    const initialSlots = Math.max(2, this.planner.desiredSlots(maxQueueSize));
    this.blocks = new Array(initialSlots).fill(null);
  }

  get isQueueFull(): boolean {
    if (this.native) return this.native.isQueueFull();
    return this._size >= this._maxQueueSize;
  }

  isQueueOverloaded(additionalSize: number): boolean {
    if (this.native) return this.native.isQueueOverloaded(additionalSize);
    return this._size + additionalSize > this._maxQueueSize;
  }

  get isMaxHeightReached(): boolean {
    if (this.native) return this.native.isMaxHeightReached();
    return this._lastHeight >= this._maxBlockHeight;
  }

  get currentSize(): number {
    if (this.native) return this.native.getCurrentSize();
    return this._size;
  }

  get length(): number {
    if (this.native) return this.native.getLength();
    return this.currentBlockCount;
  }

  get lastHeight(): number {
    if (this.native) return this.native.getLastHeight();
    return this._lastHeight;
  }

  public async enqueue(item: RawBlock): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.native) {
        this.native.validateEnqueue({ hash: item.hash, height: item.height, size: item.size });
        this.native.enqueueBytes(item.hash, item.height, item.size, item.bytes);
        return;
      }

      if (this.hashIndex.has(item.hash)) {
        throw new Error('Duplicate block hash');
      }

      const totalBlockSize = item.size;
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

      if (item.height !== this._lastHeight + 1) {
        throw new Error(`Can't enqueue block. Block number: ${item.height}, Queue last height: ${this._lastHeight}`);
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

      this.blocks[this.tailIndex] = item;
      this.heightIndex.set(item.height, this.tailIndex);
      this.hashIndex.set(item.hash, this.tailIndex);
      this.tailIndex = (this.tailIndex + 1) % this.blocks.length;
      this.currentBlockCount++;
      this._size += totalBlockSize;
      this._lastHeight = item.height;
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
        this.heightIndex.delete(block.height);
        this.hashIndex.delete(block.hash);
        this.headIndex = (this.headIndex + 1) % this.blocks.length;
        this.currentBlockCount--;
        this._size -= block.size;
        height = block.height;
      }
      return height;
    });
  }

  public findBlocks(hashSet: Set<string>): Promise<RawBlock[]> {
    return this.mutex.runExclusive(async (): Promise<RawBlock[]> => {
      if (this.native) {
        return this.native.findBlocks([...hashSet]);
      }

      const blocks: RawBlock[] = [];
      for (const hash of hashSet) {
        const bufferIndex = this.hashIndex.get(hash);
        if (bufferIndex !== undefined) {
          const block = this.blocks[bufferIndex];
          if (block) blocks.push(block);
        }
      }
      return blocks;
    });
  }

  public async getBatchUpToSize(maxSize: number): Promise<RawBlock[]> {
    return this.mutex.runExclusive(async () => {
      if (this.native) {
        return this.native.getBatchUpToSize(maxSize);
      }

      if (this.currentBlockCount === 0) return [];

      const batch: RawBlock[] = [];
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
        if (accumulatedSize + block.size > maxSize && batch.length > 0) break;
        batch.push(block);
        accumulatedSize += block.size;
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
    for (let i = 0; i < this.blocks.length; i++) this.blocks[i] = null;
    this.heightIndex.clear();
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

  public dispose(): void {
    if (this.native) {
      this.native.dispose();
      return;
    }
    this.clear();
    this.blocks.length = 0;
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
    const indexesSize = this.heightIndex.size + this.hashIndex.size;
    return {
      bufferAllocated: this.blocks.length,
      blocksUsed: this.currentBlockCount,
      bufferEfficiency: this.blocks.length > 0 ? this.currentBlockCount / this.blocks.length : 0,
      avgBlockSize: this.currentBlockCount > 0 ? this._size / this.currentBlockCount : 0,
      indexesSize,
      memoryUsedBytes: this._size,
    };
  }

  private resizeRing(newCapacity: number): void {
    if (newCapacity === this.blocks.length) return;
    const oldLen = this.blocks.length;
    const newBlocks: (RawBlock | null)[] = new Array(newCapacity).fill(null);
    this.heightIndex.clear();
    this.hashIndex.clear();

    let idx = this.headIndex;
    for (let i = 0; i < this.currentBlockCount; i++) {
      const b = this.blocks[idx];
      if (b) {
        this.heightIndex.set(b.height, i);
        this.hashIndex.set(b.hash, i);
        newBlocks[i] = b;
      }
      idx = (idx + 1) % oldLen;
    }
    this.blocks = newBlocks;
    this.headIndex = 0;
    this.tailIndex = this.currentBlockCount % this.blocks.length;
  }
}
