// import _ from 'lodash';
import { Mutex } from 'async-mutex';
// import { encode } from 'rlp';
import type { Block, Transaction } from '../blockchain-provider';

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
  private _maxQueueSize: number;
  private _blockSize: number;
  private _size: number = 0;
  private _maxBlockHeight: number;
  private readonly mutex = new Mutex();

  /**
   * Creates an instance of {@link BlocksQueue}.
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
   * Retrieves the first block in the queue without removing it.
   * @returns A promise that resolves to the first block in the queue or `undefined` if the queue is empty.
   * @complexity O(1)
   */
  public async firstBlock(): Promise<T | undefined> {
    return this.mutex.runExclusive(async () => {
      this.transferItems();
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
      this.transferItems();
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

      if (block.size !== null && block.size !== undefined) {
        totalBlockSize = Number(block.size);
      } else {
        // Calculate size using RLP encoding without copying objects
        totalBlockSize = this.calculateBlockSizeRLP(block);
      }

      // Check if adding this block would exceed the maximum queue size
      // IMORTANT: We still add the last block when the size already exceeds the maximum queue size.
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

      if (block.hex) {
        delete block.hex;
      }

      // Modify the original block by removing tx.hex and adding __size
      // IMPORTANT: // Remove tx.hex to save memory
      if (Array.isArray(block.transactions)) {
        for (const tx of block.transactions) {
          if ('hex' in tx) {
            delete tx.hex;
          }
        }
      }

      // Add the modified block to the inStack
      this.inStack.push(block);
      this._lastHeight = Number(block.blockNumber);
      this._size += totalBlockSize;
    });
  }

  public async dequeue(hashOrHashes: string | string[]) {
    const hashes: string[] = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];

    return this.mutex.runExclusive(() => {
      const results = [];

      for (const hash of hashes) {
        this.transferItems();

        const block = this.outStack[this.outStack.length - 1];
        if (block && block.hash === hash) {
          const dequeuedBlock = this.outStack.pop();
          if (dequeuedBlock) {
            this._size -= dequeuedBlock.size;
            results.push(dequeuedBlock);
          } else {
            throw new Error(`Block not found in the queue after dequeue: ${hash}`);
          }
        } else {
          throw new Error(`Block not found or hash mismatch: ${hash}`);
        }
      }

      return Array.isArray(hashOrHashes) ? results : results[0];
    });
  }

  /**
   * Prepares block data for RLP encoding without copying the original
   * @param block - Original block
   * @returns Array suitable for RLP encoding
   */
  // private prepareBlockForRLP(block: Block): any[] {
  //   const txData = [];

  //   if (Array.isArray(block.transactions)) {
  //     for (const tx of block.transactions) {
  //       if (typeof tx === 'string') {
  //         // If transaction is just a hash, skip detailed encoding
  //         txData.push(tx);
  //       } else {
  //         // Full transaction object - ensure proper order for RLP
  //         const txArray = [
  //           this.toHex(tx.nonce || 0),
  //           this.toHex(tx.gasPrice || 0),
  //           this.toHex(tx.gas || 0),
  //           tx.to || '0x',
  //           this.toHex(tx.value || 0),
  //           tx.input || '0x',
  //           this.toHex(tx.v || 0),
  //           tx.r || '0x',
  //           tx.s || '0x'
  //         ];

  //         // Add EIP-1559 fields if present
  //         if (tx.maxFeePerGas !== undefined) {
  //           txArray.push(this.toHex(tx.maxFeePerGas));
  //         }
  //         if (tx.maxPriorityFeePerGas !== undefined) {
  //           txArray.push(this.toHex(tx.maxPriorityFeePerGas));
  //         }

  //         txData.push(txArray);
  //       }
  //     }
  //   }

  //   // Ensure nonce is properly formatted
  //   const blockNonce = typeof block.nonce === 'string' && block.nonce.startsWith('0x')
  //     ? block.nonce
  //     : '0x' + (block.nonce || '0');

  //   // Standard Ethereum block header structure
  //   return [
  //     block.parentHash,
  //     block.sha3Uncles,
  //     block.miner,
  //     block.stateRoot,
  //     block.transactionsRoot,
  //     block.receiptsRoot,
  //     block.logsBloom,
  //     this.toHex(block.difficulty),
  //     this.toHex(block.blockNumber),
  //     this.toHex(block.gasLimit),
  //     this.toHex(block.gasUsed),
  //     this.toHex(block.timestamp),
  //     block.extraData,
  //     blockNonce,
  //     // block.mixHash, Important: This field is often forgotten.
  //     // baseFeePerGas только для блоков после EIP-1559
  //     ...(block.baseFeePerGas !== undefined ? [this.toHex(block.baseFeePerGas)] : []),
  //     txData
  //   ];
  // }

  /**
   * Helper method to ensure proper hex formatting
   */
  // private toHex(value: string | number): string {
  //   if (typeof value === 'string' && value.startsWith('0x')) {
  //     return value;
  //   }
  //   return '0x' + (typeof value === 'number' ? value.toString(16) : value);
  // }

  /**
   * Calculates block size using RLP encoding without creating copies
   * @param block - The block to calculate size for
   * @returns Size in bytes
   */
  private calculateBlockSizeRLP(block: T): number {
    // Fallback to hex-based calculation if RLP fails
    return this.calculateBlockSizeTransactionsHex(block);

    // try {
    //   // Prepare block data for RLP encoding
    //   const blockData = this.prepareBlockForRLP(block);

    //   // RLP encode and get size
    //   const encoded = encode(blockData);
    //   return encoded.length;
    // } catch (error) {
    //   // Fallback to hex-based calculation if RLP fails
    //   return this.calculateBlockSizeTransactionsHex(block);
    // }
  }

  /**
   * Fallback method for size calculation using hex transactions data
   * @param block - The block to calculate size for
   * @returns Size in bytes
   */
  private calculateBlockSizeTransactionsHex(block: T): number {
    let totalBlockSize = 0;

    // More accurate base block header size (excluding transactions)
    totalBlockSize += this.estimateBlockHeaderSize(block);

    if (Array.isArray(block.transactions)) {
      for (const transaction of block.transactions) {
        if (typeof transaction === 'string') {
          // Just a hash, estimate minimal size
          totalBlockSize += 32; // hash size
        } else if (transaction.hex) {
          // Calculate size from hex data (most accurate)
          const transactionSize = (transaction.hex.length - 2) / 2; // Remove '0x' prefix
          totalBlockSize += transactionSize;
        } else {
          // Estimate transaction size based on available fields
          totalBlockSize += this.estimateTransactionSize(transaction);
        }
      }
    }

    return totalBlockSize;
  }

  /**
   * Estimates block header size
   */
  private estimateBlockHeaderSize(block: T): number {
    let headerSize = 0;

    headerSize += 32; // parentHash
    headerSize += 32; // sha3Uncles
    headerSize += 20; // miner
    headerSize += 32; // stateRoot
    headerSize += 32; // transactionsRoot
    headerSize += 32; // receiptsRoot
    headerSize += 256; // logsBloom
    headerSize += 32; // difficulty
    headerSize += 8; // blockNumber
    headerSize += 8; // gasLimit
    headerSize += 8; // gasUsed
    headerSize += 8; // timestamp
    headerSize += (block.extraData?.length - 2) / 2 || 0; // extraData
    headerSize += 8; // nonce
    headerSize += 32; // mixHash

    // EIP-1559 baseFeePerGas
    if (block.baseFeePerGas !== undefined) {
      headerSize += 32;
    }

    // Add RLP encoding overhead (approximately 5-10% of raw data)
    return Math.ceil(headerSize * 1.1);
  }

  /**
   * Estimates transaction size based on its fields when hex is not available
   * @param transaction - Transaction object
   * @returns Estimated size in bytes
   */
  private estimateTransactionSize(transaction: Transaction): number {
    let size = 0;

    // Basic transaction fields
    size += 32; // hash
    size += 8; // nonce (usually small, but can be up to 32 bytes)
    size += 32; // blockHash
    size += 8; // blockNumber
    size += 8; // transactionIndex
    size += 20; // from address
    size += 20; // to address (if present)
    size += 32; // value
    size += 8; // gas
    size += 32; // gasPrice

    // Signatures (v, r, s) - исправлено
    size += 1; // v (1 byte)
    size += 32; // r (32 bytes)
    size += 32; // s (32 bytes)

    // Input data size (variable)
    if (transaction.input && transaction.input !== '0x') {
      size += (transaction.input.length - 2) / 2; // Convert hex to bytes
    }

    // EIP-1559 fields (if present)
    if (transaction.maxFeePerGas !== undefined) {
      size += 32; // maxFeePerGas
    }
    if (transaction.maxPriorityFeePerGas !== undefined) {
      size += 32; // maxPriorityFeePerGas
    }

    // EIP-2930 access list (if present)
    if (transaction.accessList && transaction.accessList.length > 0) {
      for (const entry of transaction.accessList) {
        size += 20; // address
        size += entry.storageKeys.length * 32; // storage keys
      }
    }

    // EIP-4844 blob fields (if present)
    if (transaction.blobVersionedHashes) {
      size += transaction.blobVersionedHashes.length * 32; // blob hashes
    }
    if (transaction.maxFeePerBlobGas !== undefined) {
      size += 32; // maxFeePerBlobGas
    }

    // Add RLP encoding overhead
    size = Math.ceil(size * 1.05);

    // Minimum transaction size if calculation seems too small
    return Math.max(size, 108); // Минимальный размер простой транзакции
  }

  /**
   * Retrieves a batch of blocks whose cumulative size does not exceed the specified maximum size.
   * @param maxSize - The maximum cumulative size of the batch in bytes.
   * @returns A promise that resolves to an array of blocks fitting within the specified size.
   * @throws Will throw an error if the first block exceeds the maximum batch size.
   * @complexity O(n)
   */
  public async getBatchUpToSize(maxSize: number): Promise<any> {
    return this.mutex.runExclusive(async () => {
      if (this.length === 0) {
        return [];
      }

      this.transferItems();

      const batch = [];
      let accumulatedSize = 0;
      for (let i = this.outStack.length - 1; i >= 0; i--) {
        const block = this.outStack[i];
        if (accumulatedSize + block!.size > maxSize) {
          if (batch.length === 0) {
            batch.push(block);
          }
          break;
        }
        batch.push(block);
        accumulatedSize += block!.size;
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
    return this.mutex.runExclusive(async (): Promise<any> => {
      const blocks = [];
      this.transferItems();
      for (let i = this.outStack.length - 1; i >= 0; i--) {
        const block = this.outStack[i];
        if (hashSet.has(block!.hash)) {
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
    if (this.outStack.length === 0) {
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
      const midHeight = stack[mid]!.blockNumber;

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
