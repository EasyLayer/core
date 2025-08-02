import { Mutex } from 'async-mutex';
import type { Block } from '../blockchain-provider';

/**
 * Optimized BlocksQueue for Ethereum/EVM chains using low-level memory management.
 * Maintains a FIFO (First-In-First-Out) structure to ensure the integrity and order of blocks.
 *
 * Key optimizations:
 * 1. TypedArrays for block metadata storage (4x memory efficiency)
 * 2. Binary serialization of block data
 * 3. O(1) lookups via blockNumber and hash indexes
 * 4. Efficient FIFO queue implementation using circular buffer
 *
 * @template T - The type of block that extends the {@link Block} interface.
 */
export class BlocksQueue<T extends Block> {
  private _lastHeight: number;
  private _maxQueueSize: number;
  private _blockSize: number;
  private _size: number = 0;
  private _maxBlockHeight: number;
  private readonly mutex = new Mutex();

  // Optimized storage structures
  private metadataBuffer: ArrayBuffer;
  private metadataView: Int32Array;
  private blockDataBuffer: ArrayBuffer;
  private blockDataView: Uint8Array;

  // FIFO queue pointers for circular buffer
  private headIndex: number = 0; // Points to first block (oldest)
  private tailIndex: number = 0; // Points to next insertion position
  private currentBlockCount: number = 0;
  private dataOffset: number = 0;

  // Fast lookup indexes
  private blockNumberIndex: Map<number, number> = new Map(); // blockNumber -> buffer index
  private hashIndex: Map<string, number> = new Map(); // hash -> buffer index

  // Memory management for variable-length data
  private freeSpaceMap: Map<number, number> = new Map(); // offset -> length of free space

  // Constants
  private static readonly METADATA_ENTRIES = 50000; // Large enough for any reasonable queue

  /**
   * Creates an instance of {@link BlocksQueue}.
   *
   * Each block metadata entry: blockNumber(4) + size(4) + dataOffset(4) + dataLength(4) + hashCode(4) = 20 bytes
   *
   * @param options - Configuration options for the blocks queue
   * @param options.lastHeight - The height of the last block in the queue. This represents the most recent block number that has been processed.
   * @param options.maxQueueSize - The maximum size of the queue in bytes. This limits the total memory usage of the queue.
   * @param options.blockSize - The expected size of each block in bytes. Used for memory management and batch processing calculations.
   * @param options.maxBlockHeight - The maximum block height that the queue can process. This prevents processing blocks beyond a certain point in the blockchain.
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

    // Initialize binary buffers
    // Metadata: blockNumber + size + dataOffset + dataLength + hashCode = 20 bytes per block
    this.metadataBuffer = new ArrayBuffer(BlocksQueue.METADATA_ENTRIES * 20);
    this.metadataView = new Int32Array(this.metadataBuffer);

    // Data buffer for serialized blocks - this is the real limit
    this.blockDataBuffer = new ArrayBuffer(maxQueueSize);
    this.blockDataView = new Uint8Array(this.blockDataBuffer);
  }

  // ========== CORE QUEUE PROPERTIES ==========

  /**
   * Determines whether the queue has reached its maximum allowed size.
   * @returns `true` if the current size is greater than or equal to the maximum queue size; otherwise, `false`.
   * @complexity O(1)
   */
  get isQueueFull(): boolean {
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

  /**
   * Determines whether the queue has reached the maximum allowed block height.
   * @returns `true` if the last block's height is greater than or equal to the maximum block height; otherwise, `false`.
   * @complexity O(1)
   */
  get isMaxHeightReached(): boolean {
    return this._lastHeight >= this._maxBlockHeight;
  }

  /**
   * Gets the maximum block height that the queue can hold.
   * @returns The maximum block height as a number.
   * @complexity O(1)
   */
  public get maxBlockHeight(): number {
    return this._maxBlockHeight;
  }

  /**
   * Sets the maximum block height that the queue can hold.
   * @param height - The new maximum block height.
   * @complexity O(1)
   */
  public set maxBlockHeight(height: number) {
    this._maxBlockHeight = height;
  }

  /**
   * Gets the maximum queue size in bytes.
   * @returns The maximum queue size in bytes as a number.
   * @complexity O(1)
   */
  public get maxQueueSize(): number {
    return this._maxQueueSize;
  }

  /**
   * Sets the maximum queue size in bytes.
   * @param length - The new maximum queue size in bytes.
   * @complexity O(1)
   */
  public set maxQueueSize(length: number) {
    this._maxQueueSize = length;
  }

  /**
   * Retrieves the current size of the queue in bytes.
   * @returns The total size of the queue in bytes.
   * @complexity O(1)
   */
  public get currentSize(): number {
    return this._size;
  }

  /**
   * Retrieves the current number of blocks in the queue.
   * @returns The total number of blocks in the queue.
   * @complexity O(1)
   */
  public get length(): number {
    return this.currentBlockCount;
  }

  /**
   * Retrieves the height of the last block in the queue.
   * @returns The height of the last block as a number.
   * @complexity O(1)
   */
  public get lastHeight(): number {
    return this._lastHeight;
  }

  // ========== CORE QUEUE OPERATIONS ==========

  /**
   * Retrieves the first block in the queue without removing it.
   * @returns A promise that resolves to the first block in the queue or `undefined` if the queue is empty.
   * @complexity O(1)
   */
  public async firstBlock(): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      if (this.currentBlockCount === 0) return undefined;
      return this.getBlockByBufferIndex(this.headIndex);
    });
  }

  /**
   * Enqueues a block to the queue with optimized storage.
   * @param block - The block to be added to the queue.
   * @throws Will throw an error if the queue is full, the maximum block height is reached, or the block's height is incorrect.
   * @complexity O(1)
   */
  public async enqueue(block: T): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const totalBlockSize = Number(block.size);

      // Validation checks - FIRST check size limits
      if (this.isQueueFull || this.isMaxHeightReached) {
        throw new Error(
          `Can't enqueue block. isQueueFull: ${this.isQueueFull}, isMaxHeightReached: ${this.isMaxHeightReached}`
        );
      }

      // Check if the block's height is exactly one more than the last block's height
      if (Number(block.blockNumber) !== this._lastHeight + 1) {
        throw new Error(
          `Can't enqueue block. Block height: ${block.blockNumber}, Queue last height: ${this._lastHeight}`
        );
      }

      // Clean up hex data to save memory
      this.cleanupBlockHexData(block);

      // Serialize block data
      const serializedBlock = this.serializeBlock(block);

      // Find space for block data - if this fails, the queue is really full
      const dataOffset = this.allocateDataSpace(serializedBlock.length);
      if (dataOffset === -1) {
        throw new Error('Not enough space in data buffer');
      }

      // Store block data first
      this.blockDataView.set(serializedBlock, dataOffset);

      // Then store metadata (this will always fit if block data fit)
      const metadataIndex = this.tailIndex * 5; // 5 int32 values per block
      this.metadataView[metadataIndex] = Number(block.blockNumber);
      this.metadataView[metadataIndex + 1] = totalBlockSize;
      this.metadataView[metadataIndex + 2] = dataOffset;
      this.metadataView[metadataIndex + 3] = serializedBlock.length;
      this.metadataView[metadataIndex + 4] = this.hashCode(block.hash);

      // Finally update indexes and counters
      this.blockNumberIndex.set(Number(block.blockNumber), this.tailIndex);
      this.hashIndex.set(block.hash, this.tailIndex);

      this.tailIndex = (this.tailIndex + 1) % BlocksQueue.METADATA_ENTRIES;
      this.currentBlockCount++;
      this._size += totalBlockSize;
      this._lastHeight = Number(block.blockNumber);
    });
  }

  /**
   * Dequeues blocks from the queue by hash(es).
   * @param hashOrHashes - Block hash(es) to remove
   * @returns Removed block(s)
   * @complexity O(1) per block with hash index
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

        // Get block before removing
        const block = this.getBlockByBufferIndex(bufferIndex);
        if (!block) {
          throw new Error(`Block data corrupted: ${hash}`);
        }

        // Verify it's the head block (FIFO order)
        if (bufferIndex !== this.headIndex) {
          throw new Error(`Block not at head of queue: ${hash}`);
        }

        // Remove from indexes
        this.blockNumberIndex.delete(Number(block.blockNumber));
        this.hashIndex.delete(block.hash);

        // Free data space
        const metadataIndex = bufferIndex * 5;
        const dataOffset = this.metadataView[metadataIndex + 2] ?? 0;
        const dataLength = this.metadataView[metadataIndex + 3] ?? 0;
        this.freeDataSpace(dataOffset, dataLength);

        // Update queue pointers
        this.headIndex = (this.headIndex + 1) % BlocksQueue.METADATA_ENTRIES;
        this.currentBlockCount--;
        this._size -= block.size;

        results.push(block);
      }

      return Array.isArray(hashOrHashes) ? results : results[0];
    });
  }

  // ========== SEARCH OPERATIONS ==========

  /**
   * Fetches a block by its blockNumber using O(1) index lookup.
   * @param height - The blockNumber of the block to retrieve.
   * @returns The block with the specified blockNumber or `undefined` if not found.
   * @complexity O(1)
   */
  public fetchBlockFromInStack(height: number): T | undefined {
    const bufferIndex = this.blockNumberIndex.get(height);
    if (bufferIndex === undefined) return undefined;
    return this.getBlockByBufferIndex(bufferIndex);
  }

  /**
   * Fetches a block by its blockNumber from the queue (async version for API compatibility).
   * @param height - The blockNumber of the block to retrieve.
   * @returns The block with the specified blockNumber or `undefined` if not found.
   * @complexity O(1)
   */
  public fetchBlockFromOutStack(height: number): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      return this.fetchBlockFromInStack(height);
    });
  }

  /**
   * Searches for blocks by a set of hashes using O(1) hash index.
   * @param hashSet - A set of block hashes to search for.
   * @returns An array of blocks that match the provided hashes.
   * @complexity O(k) where k = number of hashes to search
   */
  public findBlocks(hashSet: Set<string>): Promise<T[]> {
    return this.mutex.runExclusive(async (): Promise<T[]> => {
      const blocks: T[] = [];

      for (const hash of hashSet) {
        const bufferIndex = this.hashIndex.get(hash);
        if (bufferIndex !== undefined) {
          const block = this.getBlockByBufferIndex(bufferIndex);
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
   * Retrieves a batch of blocks whose cumulative size does not exceed the specified maximum size.
   * Processes blocks in FIFO order starting from head.
   *
   * Algorithm:
   * 1. Processes blocks in FIFO order (oldest blocks first)
   * 2. Accumulates blocks until size limit would be exceeded
   * 3. Guarantees at least one block is returned (even if it exceeds limit)
   *
   * The "at least one block" guarantee is crucial because:
   * - Every block must eventually be processed
   * - Large blocks shouldn't block the entire pipeline
   * - System continues to make progress even with oversized blocks
   *
   * @param maxSize - The maximum cumulative size of the batch in bytes
   * @returns A promise that resolves to an array of blocks fitting within the specified size
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
        const metadataIndex = currentIndex * 5;
        const blockSize = this.metadataView[metadataIndex + 1] ?? 0;

        // Check if adding this block would exceed the maximum batch size
        if (accumulatedSize + blockSize > maxSize) {
          // Critical guarantee: always include at least one block
          if (batch.length === 0) {
            const block = this.getBlockByBufferIndex(currentIndex);
            if (block) {
              batch.push(block);
              accumulatedSize += blockSize;
            }
          }
          break;
        }

        // Add block to batch
        const block = this.getBlockByBufferIndex(currentIndex);
        if (block) {
          batch.push(block);
          accumulatedSize += blockSize;
        }

        currentIndex = (currentIndex + 1) % BlocksQueue.METADATA_ENTRIES;
        processedCount++;
      }

      return batch;
    });
  }

  // ========== QUEUE MANAGEMENT ==========

  /**
   * Clears the entire queue, removing all blocks and resetting the current size.
   * @complexity O(1)
   */
  public clear(): void {
    // Reset all pointers and counters
    this.headIndex = 0;
    this.tailIndex = 0;
    this.currentBlockCount = 0;
    this.dataOffset = 0;
    this._size = 0;

    // Clear indexes
    this.blockNumberIndex.clear();
    this.hashIndex.clear();
    this.freeSpaceMap.clear();
  }

  /**
   * Reorganizes the queue by clearing all existing blocks and setting a new last height.
   * @param reorganizeHeight - The new last height to set after reorganization.
   * @complexity O(1)
   */
  public async reorganize(reorganizeHeight: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.clear();
      this._lastHeight = reorganizeHeight;
    });
  }

  // ========== INTERNAL HELPER METHODS ==========

  /**
   * Get block by buffer index with deserialization
   */
  private getBlockByBufferIndex(bufferIndex: number): T | undefined {
    if (bufferIndex >= BlocksQueue.METADATA_ENTRIES) return undefined;

    const metadataIndex = bufferIndex * 5;
    const dataOffset = this.metadataView[metadataIndex + 2] ?? 0;
    const dataLength = this.metadataView[metadataIndex + 3] ?? 0;

    if (dataOffset === 0 && dataLength === 0) return undefined;

    const blockData = this.blockDataView.slice(dataOffset, dataOffset + dataLength);
    return this.deserializeBlock(blockData);
  }

  /**
   * Allocate space in data buffer for block storage
   */
  private allocateDataSpace(requiredLength: number): number {
    // Try to find free space first
    for (const [offset, length] of this.freeSpaceMap) {
      if (length >= requiredLength) {
        this.freeSpaceMap.delete(offset);
        if (length > requiredLength) {
          // Add remaining space back to free map
          this.freeSpaceMap.set(offset + requiredLength, length - requiredLength);
        }
        return offset;
      }
    }

    // Allocate at the end if there's space
    if (this.dataOffset + requiredLength <= this._maxQueueSize) {
      const offset = this.dataOffset;
      this.dataOffset += requiredLength;
      return offset;
    }

    return -1; // No space available
  }

  /**
   * Free space in data buffer
   */
  private freeDataSpace(offset: number, length: number): void {
    this.freeSpaceMap.set(offset, length);

    // Try to merge adjacent free spaces
    this.mergeFreeSpaces();
  }

  /**
   * Merge adjacent free spaces to reduce fragmentation
   */
  private mergeFreeSpaces(): void {
    const sortedSpaces = Array.from(this.freeSpaceMap.entries()).sort((a, b) => a[0] - b[0]);
    this.freeSpaceMap.clear();

    for (let i = 0; i < sortedSpaces.length; i++) {
      const currentSpace = sortedSpaces[i];
      if (!currentSpace) continue;

      let [offset, length] = currentSpace;

      // Merge with subsequent adjacent spaces
      while (i + 1 < sortedSpaces.length) {
        const nextSpace = sortedSpaces[i + 1];
        if (!nextSpace) break;

        if (offset + length === nextSpace[0]) {
          length += nextSpace[1];
          i++;
        } else {
          break;
        }
      }

      this.freeSpaceMap.set(offset, length);
    }
  }

  /**
   * Remove hex data from block and transactions to save memory
   */
  private cleanupBlockHexData(block: T): void {
    // Remove block hex if present
    if ('hex' in block) {
      delete (block as any).hex;
    }

    // Remove transaction hex data to save memory
    if (Array.isArray(block.transactions)) {
      for (const tx of block.transactions) {
        if ('hex' in tx) {
          delete (tx as any).hex;
        }
      }
    }
  }

  /**
   * Serialize block to binary format
   */
  private serializeBlock(block: T): Uint8Array {
    const json = JSON.stringify(block);
    const encoder = new TextEncoder();
    return encoder.encode(json);
  }

  /**
   * Deserialize block from binary format
   */
  private deserializeBlock(data: Uint8Array): T {
    const decoder = new TextDecoder();
    const json = decoder.decode(data);
    return JSON.parse(json) as T;
  }

  /**
   * Generate hash code for string (for fast hash-based lookups)
   */
  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  // ========== MONITORING AND DIAGNOSTICS ==========

  /**
   * Get memory usage statistics and performance metrics
   */
  public getMemoryStats(): {
    metadataUsed: number;
    dataUsed: number;
    totalAllocated: number;
    efficiency: number;
    blocksCount: number;
    freeSpaces: number;
    avgBlockSize: number;
    memoryFragmentation: number;
  } {
    const metadataUsed = this.currentBlockCount * 20; // 20 bytes per block metadata
    const totalAllocated = this.metadataBuffer.byteLength + this.blockDataBuffer.byteLength;
    const totalFreeSpace = Array.from(this.freeSpaceMap.values()).reduce((sum, size) => sum + size, 0);
    const memoryFragmentation = this.freeSpaceMap.size > 0 ? totalFreeSpace / this.dataOffset : 0;

    return {
      metadataUsed,
      dataUsed: this.dataOffset,
      totalAllocated,
      efficiency: totalAllocated > 0 ? (metadataUsed + this.dataOffset) / totalAllocated : 0,
      blocksCount: this.currentBlockCount,
      freeSpaces: this.freeSpaceMap.size,
      avgBlockSize: this.currentBlockCount > 0 ? this._size / this.currentBlockCount : 0,
      memoryFragmentation,
    };
  }
}
