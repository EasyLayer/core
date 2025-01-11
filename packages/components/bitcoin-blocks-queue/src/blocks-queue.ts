// import _ from 'lodash';
import { Mutex } from 'async-mutex';
import { Block } from './interfaces';

/**
 * Represents a queue specifically designed for managing blocks in a blockchain context.
 * Maintains a FIFO (First-In-First-Out) structure to ensure the integrity and order of blocks.
 *
 * @template T - The type of block that extends the {@link Block} interface.
 */
export class BlocksQueue<T extends Block> {
  private inStack: T[] = [];
  private outStack: T[] = [];
  private _lastHeight: number;
  private _maxQueueSize: number = 10 * 1024 * 1024; // Bytes
  private _size: number = 0; // Bytes
  private _minTransferSize: number = 1 * 1024 * 1024; // Bytes
  private _maxBlockHeight: number = Number.MAX_SAFE_INTEGER;
  private readonly mutex = new Mutex();

  /**
   * Creates an instance of {@link BlocksQueue}.
   *
   * @param lastHeight - The height of the last block in the queue.
   */
  constructor(lastHeight: number) {
    this._lastHeight = lastHeight;
  }

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
  public get length() {
    return this.inStack.length + this.outStack.length;
  }

  /**
   * Retrieves the height of the last block in the queue.
   * @returns The height of the last block as a number.
   * @complexity O(1)
   */
  public get lastHeight(): number {
    return this._lastHeight;
  }

  /**
   * Gets the minimum transfer size in bytes.
   * @returns The minimum transfer size in bytes as a number.
   * @complexity O(1)
   */
  public get minTransferSize(): number {
    return this._minTransferSize;
  }

  /**
   * Sets the minimum transfer size in bytes.
   * @param size - The new minimum transfer size in bytes.
   * @complexity O(1)
   */
  public set minTransferSize(size: number) {
    this._minTransferSize = size;
  }

  /**
   * Retrieves the first block in the queue without removing it.
   * @returns A promise that resolves to the first block in the queue or `undefined` if the queue is empty.
   * @complexity O(1)
   */
  public async firstBlock(): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      if (this.outStack.length === 0) {
        this.transferItems();
      }
      return this.outStack[this.outStack.length - 1];
    });
  }

  /**
   * Fetches a block by its height from the `inStack` using binary search.
   * @param height - The height of the block to retrieve.
   * @returns The block with the specified height or `undefined` if not found.
   * @complexity O(log n)
   */
  public fetchBlockFromInStack(height: number): T | undefined {
    return this.binarySearch(this.inStack, height, true);
  }

  /**
   * Fetches a block by its height from the `outStack` using binary search.
   * @param height - The height of the block to retrieve.
   * @returns The block with the specified height or `undefined` if not found.
   * @complexity O(log n)
   */
  public fetchBlockFromOutStack(height: number): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      if (this.outStack.length === 0) {
        this.transferItems();
      }
      return this.binarySearch(this.outStack, height, false);
    });
  }

  /**
   * Enqueues a block to the queue if it meets the following conditions:
   * - Its height is exactly one more than the height of the last block in the queue.
   * - Adding it does not exceed the maximum queue size.
   * - The queue has not reached the maximum block height.
   * @param block - The block to be added to the queue.
   * @throws Will throw an error if the queue is full, the maximum block height is reached, or the block's height is incorrect.
   * @complexity O(n) - due to iteration over transactions
   */
  public async enqueue(block: T): Promise<void> {
    await this.mutex.runExclusive(async () => {
      // Calculate the total block size based on tx.hex without modifying the original block
      let totalBlockSize = 0;

      if (block.size) {
        totalBlockSize = Number(block.size);
      } else {
        totalBlockSize = 0;
        for (const transaction of block.tx) {
          if (transaction.size) {
            totalBlockSize += Number(transaction.size);
          } else if (transaction.hex) {
            const transactionSize = transaction.hex.length / 2;
            totalBlockSize += transactionSize;
          } else {
            throw new Error(
              `Invalid transaction data. Either size or hex must be present. Transaction: ${JSON.stringify(
                transaction
              )}`
            );
          }
        }
      }

      // Check if adding this block would exceed the maximum queue size
      // IMORTANT: We still add the last block when the size already exceeds the maximum queue size.
      if (this.isQueueFull || this.isMaxHeightReached) {
        throw new Error(
          `Can't enqueue block. isQueueFull: ${this.isQueueFull}, isMaxHeightReached: ${this.isMaxHeightReached}`
        );
      }

      // Check if the block's height is exactly one more than the last block's height
      if (Number(block.height) !== this._lastHeight + 1) {
        throw new Error(`Can't enqueue block. Block height: ${block.height}, Queue last height: ${this._lastHeight}`);
      }

      // Modify the original block by removing tx.hex and adding __size
      for (const transaction of block.tx) {
        // IMPORTANT: // Remove tx.hex to save memory
        delete transaction.hex;
      }

      // Add the modified block to the inStack
      this.inStack.push(block);
      this._lastHeight = Number(block.height);
      this._size += totalBlockSize;
    });
  }

  public async dequeue(hash: string) {
    return this.mutex.runExclusive(() => {
      if (this.outStack.length === 0) {
        this.transferItems();
      }

      const block = this.outStack[this.outStack.length - 1];
      if (block && block.hash === hash) {
        const dequeuedBlock = this.outStack.pop();
        if (dequeuedBlock) {
          this._size -= dequeuedBlock.size;
          return dequeuedBlock;
        } else {
          throw new Error(`Block not found in the queue after dequeue: ${hash}`);
        }
      } else {
        throw new Error(`Block not found or hash mismatch: ${hash}, ${block}`);
      }
    });
  }

  /**
   * Retrieves a batch of blocks whose cumulative size does not exceed the specified maximum size.
   * @param maxSize - The maximum cumulative size of the batch in bytes.
   * @returns A promise that resolves to an array of blocks fitting within the specified size.
   * @throws Will throw an error if the first block exceeds the maximum batch size.
   * @complexity O(n)
   */
  public async getBatchUpToSize(maxSize: number) {
    return this.mutex.runExclusive(async () => {
      if (this.length === 0) {
        return [];
      }
      if (this.outStack.length === 0) {
        this.transferItems();
      }

      const batch = [];
      let accumulatedSize = 0;
      for (let i = this.outStack.length - 1; i >= 0; i--) {
        const block = this.outStack[i];
        if (accumulatedSize + block.size > maxSize) {
          if (batch.length === 0) {
            batch.push(block);
          }
          break;
        }
        batch.push(block);
        accumulatedSize += block.size;
      }
      return batch;
    });
  }

  /**
   * Clears the entire queue, removing all blocks and resetting the current size.
   * @complexity O(1)
   */
  public clear(): void {
    // Clear the entire queue
    this.inStack = [];
    this.outStack = [];
    this._size = 0;
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

  /**
   * Searches for blocks in the `outStack` by a set of hashes, starting from the end.
   * @param hashSet - A set of block hashes to search for.
   * @returns An array of blocks that match the provided hashes.
   * @complexity O(n)
   */
  public findBlocks(hashSet: Set<string>): Promise<T[]> {
    return this.mutex.runExclusive(async () => {
      const blocks = [];
      if (this.outStack.length === 0) {
        this.transferItems();
      }
      for (let i = this.outStack.length - 1; i >= 0; i--) {
        const block = this.outStack[i];
        if (hashSet.has(block.hash)) {
          blocks.push(block);
          if (blocks.length === hashSet.size) {
            break;
          }
        }
      }
      return blocks;
    });
  }

  /**
   * Transfers all items from the `inStack` to the `outStack`.
   * @complexity O(n)
   */
  private transferItems(): void {
    // IMPORTANT: This is necessary to specify the lower limit of the batch size.
    // This value must be less than the minimum size of 1 current network block.
    // (current real-time blockchain block size at the time the queue was started)
    if (this._size > this._minTransferSize) {
      while (this.inStack.length > 0) {
        this.outStack.push(this.inStack.pop()!);
      }
    }
  }

  /**
   * Performs a binary search to find a block by its height within a specified stack.
   * @param stack - The stack (either `inStack` or `outStack`) to search within.
   * @param height - The height of the block to find.
   * @param isInStack - Indicates whether the search is being performed in the `inStack`.
   * @returns The block if found; otherwise, `undefined`.
   * @complexity O(log n)
   */
  private binarySearch(stack: T[], height: number, isInStack: boolean): T | undefined {
    let left = 0;
    let right = stack.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midHeight = stack[mid].height;

      if (midHeight === height) {
        return stack[mid];
      } else if (isInStack) {
        if (midHeight < height) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      } else {
        if (midHeight > height) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
    }

    return undefined;
  }
}
