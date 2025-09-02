import { Mutex } from 'async-mutex';
import type { Block } from '../blockchain-provider';

/**
 * Optimized BlocksQueue with O(1) operations but simpler implementation.
 *
 * Key optimizations:
 * 1. O(1) lookups via height and hash indexes
 * 2. Circular buffer for FIFO queue
 * 3. Direct object storage (no serialization overhead)
 * 4. Memory cleanup for hex data
 */
export class BlocksQueue<T extends Block = Block> {
  private _lastHeight: number;
  private _maxQueueSize: number;
  private _blockSize: number;
  private _size: number = 0; // Bytes
  private _maxBlockHeight: number;
  private readonly mutex = new Mutex();

  // Simple circular buffer for blocks
  private blocks: (T | null)[];

  // FIFO queue pointers
  private headIndex: number = 0; // Points to first block (oldest)
  private tailIndex: number = 0; // Points to next insertion position
  private currentBlockCount: number = 0;

  // Fast lookup indexes
  private heightIndex: Map<number, number> = new Map(); // height -> buffer index
  private hashIndex: Map<string, number> = new Map(); // hash -> buffer index

  /**
   * Creates an instance of BlocksQueue with simplified optimization.
   */
  constructor({
    lastHeight,
    maxQueueSize,
    blockSize,
    maxBlockHeight,
  }: {
    lastHeight: number;
    maxQueueSize: number;
    blockSize: number;
    maxBlockHeight: number;
  }) {
    this._lastHeight = lastHeight;
    this._maxQueueSize = maxQueueSize;
    this._blockSize = blockSize;
    this._maxBlockHeight = maxBlockHeight;

    // Pre-allocate circular buffer with enough space for worst-case scenario
    // Worst case: all blocks are minimum size (assume 1KB minimum)
    const minBlockSize = 1024; // 1KB
    const maxPossibleBlocks = Math.ceil(maxQueueSize / minBlockSize);
    this.blocks = new Array(maxPossibleBlocks).fill(null);
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
   * Enqueues a block to the queue with O(1) performance.
   * @complexity O(1)
   */
  public async enqueue(block: T): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (this.hashIndex.has((block as any).hash)) {
        throw new Error('Duplicate block hash');
      }

      // Use the calculated block size from Block interface
      const totalBlockSize = Number(block.size);

      // Check height sequence
      if (Number(block.height) !== this._lastHeight + 1) {
        throw new Error(`Can't enqueue block. Block height: ${block.height}, Queue last height: ${this._lastHeight}`);
      }

      // Check max height limit
      if (this.isMaxHeightReached) {
        throw new Error(`Can't enqueue block. Max height reached: ${this._maxBlockHeight}`);
      }

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
   * Dequeues blocks from the queue by hash(es).
   * @complexity O(1) per block
   */
  public async dequeue(hashOrHashes: string | string[]) {
    const hashes: string[] = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];

    return this.mutex.runExclusive(() => {
      const results = [];

      for (const hash of hashes) {
        const bufferIndex = this.hashIndex.get(hash);
        if (bufferIndex === undefined) {
          throw new Error(`Block not found: ${hash}`);
        }

        // Verify it's the head block (FIFO order)
        if (bufferIndex !== this.headIndex) {
          throw new Error(`Block not at head of queue: ${hash}`);
        }

        const block = this.blocks[this.headIndex];
        if (!block) {
          throw new Error(`Block data corrupted: ${hash}`);
        }

        // Remove block and update indexes
        this.blocks[this.headIndex] = null;
        this.heightIndex.delete(Number(block.height));
        this.hashIndex.delete(block.hash);

        // Update queue pointers
        this.headIndex = (this.headIndex + 1) % this.blocks.length;
        this.currentBlockCount--;
        this._size -= block.size;

        results.push(block);
      }

      return Array.isArray(hashOrHashes) ? results : results[0];
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

  // ========== MONITORING ==========

  /**
   * Get simple memory usage statistics
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
      bufferEfficiency: this.currentBlockCount / this.blocks.length,
      avgBlockSize: this.currentBlockCount > 0 ? this._size / this.currentBlockCount : 0,
      indexesSize,
      memoryUsedBytes: this._size,
    };
  }
}
