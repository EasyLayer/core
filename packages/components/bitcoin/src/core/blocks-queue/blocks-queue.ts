import { Mutex } from 'async-mutex';
import type { Block } from '../blockchain-provider';

/**
 * CapacityPlanner — dynamic ring capacity planner driven by EMA of block sizes.
 *
 * - Keeps an exponential moving average (EMA) of observed block sizes:
 *     ema = alpha * sample + (1 - alpha) * ema
 * - Computes "desired" ring capacity as floor(maxQueueBytes / ema).
 * - Triggers rare resizes (grow/shrink) using thresholds and a cooldown.
 * - Never shrinks below current occupancy (to preserve FIFO contents).
 *
 * Why EMA:
 * - Block sizes drift over time (bursts, upgrades). EMA reacts to trends while
 *   ignoring one-off outliers (less jitter).
 *
 * Why thresholds + cooldown:
 * - To avoid frequent O(n) ring re-allocations on minor changes.
 * - Cooldown ensures capacity adjustments happen rarely and predictably.
 */
export interface PlannerConfig {
  maxSlots?: number; // hard cap for ring length
  minSlots?: number; // never below this
  minAvgBytes?: number; // clamp EMA low bound
  maxAvgBytes?: number; // clamp EMA high bound
  alpha?: number; // EMA smoothing factor
  growThreshold?: number; // +30% desired vs current => grow
  shrinkThreshold?: number; // -40% desired vs current => shrink
  resizeCooldownMs?: number; // min time between resizes
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

    this.minAvgBytes = cfg.minAvgBytes ?? 256;
    this.maxAvgBytes = cfg.maxAvgBytes ?? 64 * 1024;

    this.alpha = cfg.alpha ?? 0.05;
    this.growThreshold = cfg.growThreshold ?? 0.3;
    this.shrinkThreshold = cfg.shrinkThreshold ?? 0.4;
    this.resizeCooldownMs = cfg.resizeCooldownMs ?? 10_000;

    const clampedInit = Math.max(this.minAvgBytes, Math.min(initialAvgBytes, this.maxAvgBytes));
    this.emaAvgSize = clampedInit;
  }

  /** Observe a new sample (block size in bytes). O(1) */
  observe(sampleBytes: number) {
    const s = Math.max(1, Math.min(sampleBytes, this.maxAvgBytes * 4)); // defensive clamp
    this.emaAvgSize = this.alpha * s + (1 - this.alpha) * this.emaAvgSize;
    // Clamp EMA to avoid pathological spikes
    this.emaAvgSize = Math.max(this.minAvgBytes, Math.min(this.emaAvgSize, this.maxAvgBytes));
  }

  /** Current EMA value in bytes. O(1) */
  getAvg(): number {
    return this.emaAvgSize;
  }

  /** Compute desired ring capacity under memory budget. O(1) */
  desiredSlots(maxQueueBytes: number): number {
    const base = Math.max(1, this.emaAvgSize);
    const raw = Math.floor(maxQueueBytes / base);
    return Math.max(this.minSlots, Math.min(this.maxSlots, raw));
  }

  /**
   * Decide if we should resize now (cooldown, thresholds, occupancy).
   * O(1)
   */
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
    const needShrink = desired < Math.ceil(currentCapacity * (1 - this.shrinkThreshold)) && desired >= currentCount; // never shrink below occupancy

    if (!needGrow && !needShrink) {
      return { need: false, targetSlots: currentCapacity };
    }

    const target = Math.max(currentCount, desired);
    return { need: true, targetSlots: target };
  }

  /** Mark that a resize has just occurred (starts cooldown). O(1) */
  markResized(now: number) {
    this.lastResizeAt = now;
  }
}

/**
 * BlocksQueue with O(1) operations, dynamic ring capacity planning (EMA) and rare O(n) resizes.
 *
 * Key optimizations:
 * 1. O(1) lookups via height/hash indexes (Maps from height/hash to ring index)
 * 2. Circular buffer for FIFO queue (head/tail pointers)
 * 3. Direct object storage (no serialization overhead)
 * 4. Memory cleanup for hex data
 * 5. Dynamic capacity via CapacityPlanner (EMA + thresholds + cooldown)
 *
 * Complexity:
 * - enqueue: O(1) amortized; may trigger rare O(n) resize (copying current items)
 * - dequeue: O(1) per removed block
 * - firstBlock: O(1)
 * - fetch by height/hash: O(1)
 * - findBlocks(hashes): O(k)
 * - getBatchUpToSize: O(n) over returned batch (<= current count)
 * - reorganize/clear: O(n) due to index resets
 */
export class BlocksQueue<T extends Block = Block> {
  private _lastHeight: number;
  private _maxQueueSize: number; // bytes budget
  private _blockSize: number; // initial expected size (seed for EMA)
  private _size: number = 0; // current bytes used
  private _maxBlockHeight: number;
  private readonly mutex = new Mutex();

  // Capacity planner (EMA + thresholds)
  private planner: CapacityPlanner;

  // Circular buffer for blocks
  private blocks: (T | null)[];

  // FIFO pointers
  private headIndex: number = 0; // Points to first block (oldest)
  private tailIndex: number = 0; // Points to next insertion position
  private currentBlockCount: number = 0;

  // Fast lookup indexes
  private heightIndex: Map<number, number> = new Map(); // height -> buffer index
  private hashIndex: Map<string, number> = new Map(); // hash -> buffer index

  constructor({
    lastHeight,
    maxQueueSize,
    blockSize,
    maxBlockHeight,
    plannerConfig,
  }: {
    lastHeight: number;
    maxQueueSize: number; // bytes
    blockSize: number; // initial avg seed (bytes)
    maxBlockHeight: number;
    plannerConfig?: PlannerConfig; // optional tuning
  }) {
    this._lastHeight = lastHeight;
    this._maxQueueSize = maxQueueSize;
    this._blockSize = blockSize;
    this._maxBlockHeight = maxBlockHeight;

    // Initialize EMA planner with initial expected block size
    this.planner = new CapacityPlanner(this._blockSize, plannerConfig);

    // Initial capacity from planner (under budget). Ensure at least 2 to reduce startup friction.
    const initialSlots = Math.max(2, this.planner.desiredSlots(this._maxQueueSize));
    this.blocks = new Array(initialSlots).fill(null);
  }

  // ========== CORE QUEUE PROPERTIES ==========

  public get isQueueFull(): boolean {
    return this._size >= this._maxQueueSize;
  }

  public isQueueOverloaded(additionalSize: number): boolean {
    const projectedSize = this.currentSize + additionalSize;
    return projectedSize > this.maxQueueSize;
  }

  public get blockSize(): number {
    return this._blockSize;
  }

  public set blockSize(size: number) {
    this._blockSize = size;
    // We keep EMA from observations; no immediate re-seed by default.
  }

  get isMaxHeightReached(): boolean {
    return this._lastHeight >= this._maxBlockHeight;
  }

  public get maxBlockHeight(): number {
    return this._maxBlockHeight;
  }

  public set maxBlockHeight(height: number) {
    this._maxBlockHeight = height;
  }

  public get maxQueueSize(): number {
    return this._maxQueueSize;
  }

  public set maxQueueSize(length: number) {
    this._maxQueueSize = length;
    // No immediate resize; ring adapts as new blocks arrive (observe + maybeResize).
  }

  public get currentSize(): number {
    return this._size;
  }

  public get length(): number {
    return this.currentBlockCount;
  }

  public get lastHeight(): number {
    return this._lastHeight;
  }

  /**
   * Retrieves the first block in the queue without removing it.
   * @complexity O(1)
   */
  public async firstBlock(): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      if (this.currentBlockCount === 0) return undefined;
      return this.blocks[this.headIndex] || undefined;
    });
  }

  /**
   * Enqueues a block to the queue.
   * @complexity O(1) amortized; may trigger rare O(n) ring resize under mutex.
   */
  public async enqueue(block: T): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.hashIndex.has((block as any).hash)) {
        throw new Error('Duplicate block hash');
      }

      const totalBlockSize = Number(block.size);

      // Update EMA and plan capacity (rare resize if needed)
      this.planner.observe(totalBlockSize);
      const decision = this.planner.shouldResize({
        now: Date.now(),
        maxQueueBytes: this._maxQueueSize,
        currentCapacity: this.blocks.length,
        currentCount: this.currentBlockCount,
      });
      if (decision.need) {
        this.resizeRing(decision.targetSlots); // O(n) copy of existing items
        this.planner.markResized(Date.now());
      }

      // Check height sequence
      if (Number(block.height) !== this._lastHeight + 1) {
        throw new Error(`Can't enqueue block. Block height: ${block.height}, Queue last height: ${this._lastHeight}`);
      }

      // Check max height limit
      if (this.isMaxHeightReached) {
        throw new Error(`Can't enqueue block. Max height reached: ${this._maxBlockHeight}`);
      }

      // --- Emergency grow before failing capacity ---
      // This is crucial at startup when EMA is not yet representative and ring can be too small.
      if (this.currentBlockCount >= this.blocks.length) {
        const desired = this.planner.desiredSlots(this._maxQueueSize);
        const doubled = Math.min(this.blocks.length * 2, 100_000); // hard cap
        const target = Math.max(this.currentBlockCount + 1, desired, doubled);
        if (target > this.blocks.length) {
          this.resizeRing(target);
          this.planner.markResized(Date.now());
        }
        // If still no space, fail explicitly (no silent overwrite).
        if (this.currentBlockCount >= this.blocks.length) {
          throw new Error(`Queue ring buffer capacity exceeded: ${this.blocks.length}`);
        }
      }
      // --- End emergency grow ---

      // Check ONLY memory size limit
      if (this._size + totalBlockSize > this._maxQueueSize) {
        throw new Error(
          `Can't enqueue block. Would exceed memory limit: ${this._size + totalBlockSize}/${this._maxQueueSize} bytes`
        );
      }

      // Clean up hex data to save memory
      this.cleanupBlockHexData(block);

      // Store block in circular buffer
      this.blocks[this.tailIndex] = block;

      // Update indexes for O(1) lookups
      this.heightIndex.set(Number(block.height), this.tailIndex);
      this.hashIndex.set(block.hash, this.tailIndex);

      // Update pointers and counters
      this.tailIndex = (this.tailIndex + 1) % this.blocks.length;
      this.currentBlockCount++;
      this._size += totalBlockSize;
      this._lastHeight = Number(block.height);
    });
  }

  /**
   * Dequeues blocks by hash(es).
   * @complexity O(1) per block. Returns count removed.
   */
  public async dequeue(hashOrHashes: string | string[]): Promise<number> {
    const hashes: string[] = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];

    return this.mutex.runExclusive(() => {
      let removed = 0;

      for (const hash of hashes) {
        const bufferIndex = this.hashIndex.get(hash);
        if (bufferIndex === undefined) {
          throw new Error(`Block not found: ${hash}`);
        }

        if (bufferIndex !== this.headIndex) {
          throw new Error(`Block not at head of queue: ${hash}`);
        }

        const block = this.blocks[this.headIndex];
        if (!block) {
          throw new Error(`Block data corrupted: ${hash}`);
        }

        this.blocks[this.headIndex] = null;
        this.heightIndex.delete(Number(block.height));
        this.hashIndex.delete(block.hash);

        this.headIndex = (this.headIndex + 1) % this.blocks.length;
        this.currentBlockCount--;
        this._size -= block.size;

        removed++;
      }

      return removed;
    });
  }

  // ========== SEARCH OPERATIONS ==========

  /**
   * Fetches a block by its height using O(1) index lookup.
   * @complexity O(1)
   */
  public fetchBlockFromInStack(height: number): T | undefined {
    const bufferIndex = this.heightIndex.get(height);
    if (bufferIndex === undefined) return undefined;
    return this.blocks[bufferIndex] || undefined;
  }

  /**
   * Fetches a block by its height from the queue (async version).
   * @complexity O(1)
   */
  public fetchBlockFromOutStack(height: number): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      return this.fetchBlockFromInStack(height);
    });
  }

  /**
   * Searches for blocks by a set of hashes using O(1) hash index.
   * @complexity O(k) where k = number of hashes
   */
  public findBlocks(hashSet: Set<string>): Promise<T[]> {
    return this.mutex.runExclusive(async (): Promise<T[]> => {
      const blocks: T[] = [];

      for (const hash of hashSet) {
        const bufferIndex = this.hashIndex.get(hash);
        if (bufferIndex !== undefined) {
          const block = this.blocks[bufferIndex];
          if (block) {
            blocks.push(block);
          }
        }
      }

      return blocks;
    });
  }

  // ========== BATCH OPERATIONS ==========

  /**
   * Retrieves a batch of blocks in FIFO order up to specified size.
   * Always returns at least one block if queue is non-empty.
   * @complexity O(n) where n is the number of blocks in the batch
   */
  public async getBatchUpToSize(maxSize: number): Promise<T[]> {
    return this.mutex.runExclusive(async () => {
      if (this.currentBlockCount === 0) {
        return [];
      }

      const batch: T[] = [];
      let accumulatedSize = 0;
      let currentIndex = this.headIndex;
      let processedCount = 0;

      // Process blocks in FIFO order
      while (processedCount < this.currentBlockCount) {
        const block = this.blocks[currentIndex];
        if (!block) {
          currentIndex = (currentIndex + 1) % this.blocks.length;
          processedCount++;
          continue;
        }

        const blockSize = Number(block.size);

        // Check if adding this block would exceed the maximum batch size
        if (accumulatedSize + blockSize > maxSize) {
          // Always include at least one block
          if (batch.length === 0) {
            batch.push(block);
            accumulatedSize += blockSize;
          }
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

  // ========== QUEUE MANAGEMENT ==========

  /**
   * Clears the entire queue.
   * @complexity O(n) - needs to clear indexes
   */
  public clear(): void {
    // Reset all pointers and counters
    this.headIndex = 0;
    this.tailIndex = 0;
    this.currentBlockCount = 0;
    this._size = 0;

    // Clear the blocks array
    this.blocks.fill(null);

    // Clear indexes
    this.heightIndex.clear();
    this.hashIndex.clear();
  }

  /**
   * Reorganizes the queue by clearing and setting new last height.
   * @complexity O(n)
   */
  public async reorganize(reorganizeHeight: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.clear();
      this._lastHeight = reorganizeHeight;
    });
  }

  // ========== HELPER METHODS ==========

  /**
   * Remove hex data from block and transactions to save memory
   * @complexity O(txCount) per block, typically small
   */
  private cleanupBlockHexData(block: T): void {
    const anyBlock = block as any;
    anyBlock.hex = undefined;
    const transactions = anyBlock.tx;
    if (Array.isArray(transactions)) {
      for (let i = 0, n = transactions.length; i < n; i++) {
        const transaction = transactions[i];
        if (transaction) transaction.hex = undefined;
      }
    }
  }

  /**
   * Reallocate ring buffer preserving FIFO order and rebuilding indexes.
   * Must be called under mutex.
   * @complexity O(n) where n = currentBlockCount
   */
  private resizeRing(newCapacity: number): void {
    if (newCapacity === this.blocks.length) return;

    const newBlocks: (T | null)[] = new Array(newCapacity).fill(null);

    // Rebuild indexes from scratch
    this.heightIndex.clear();
    this.hashIndex.clear();

    // Copy existing elements in FIFO order to [0..currentBlockCount)
    let idx = this.headIndex;
    for (let i = 0; i < this.currentBlockCount; i++) {
      const b = this.blocks[idx];
      if (b) {
        newBlocks[i] = b;
        this.heightIndex.set(Number(b.height), i);
        this.hashIndex.set(b.hash, i);
      }
      idx = (idx + 1) % this.blocks.length;
    }

    // Reset pointers
    this.blocks = newBlocks;
    this.headIndex = 0;
    this.tailIndex = this.currentBlockCount % this.blocks.length;
  }

  // ========== MONITORING ==========

  /**
   * Get simple memory usage statistics
   * @complexity O(1)
   */
  public getMemoryStats(): {
    bufferAllocated: number;
    blocksUsed: number;
    bufferEfficiency: number;
    avgBlockSize: number;
    indexesSize: number;
    memoryUsedBytes: number;
  } {
    const indexesSize = this.heightIndex.size + this.hashIndex.size;

    return {
      bufferAllocated: this.blocks.length,
      blocksUsed: this.currentBlockCount,
      bufferEfficiency: this.blocks.length > 0 ? this.currentBlockCount / this.blocks.length : 0,
      // Note: this is average of *stored* blocks; for EMA use planner.getAvg()
      avgBlockSize: this.currentBlockCount > 0 ? this._size / this.currentBlockCount : 0,
      indexesSize,
      memoryUsedBytes: this._size,
    };
  }
}
