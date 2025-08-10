import type { Block, LightBlock } from '../../blockchain-provider';

export class Chain {
  block!: LightBlock;
  next: Chain | null = null;
  prev: Chain | null = null;
}

/**
 * Blockchain class representing a doubly linked list of blocks.
 * Each block contains a height, hash, previous hash, and transaction IDs.
 * The blockchain has a fixed maximum size and automatically removes the oldest blocks
 * when new blocks are added beyond this size.
 * SPV Validation:
 * 1. Merkle Tree - verify merkleroot matches calculated root from transactions
 * 2. Chain connectivity - prevHash → nextHash
 */
export class Blockchain {
  private _head: Chain | null = null;
  private _tail: Chain | null = null;
  private _size: number = 0;
  // _maxSize - Maximum number of blocks allowed in the blockchain at any given time.
  private _maxSize: number;
  private _baseBlockHeight: number;

  // Fast lookup index for O(1) height search
  private heightIndex: Map<number, Chain> = new Map();

  constructor({ maxSize, baseBlockHeight = -1 }: { maxSize: number; baseBlockHeight?: number }) {
    this._maxSize = maxSize;
    this._baseBlockHeight = baseBlockHeight;
  }

  get head() {
    return this._head;
  }

  get tail() {
    return this._tail;
  }

  // Gets the hash of the first block in the chain.
  // Complexity: O(1)
  get firstBlockHash(): string | undefined {
    return this._head ? this._head.block.hash : undefined;
  }

  // eslint-disable-next-line getter-return
  get lastBlock(): LightBlock | undefined {
    if (this._tail) {
      return this._tail.block;
    }
  }

  /**
   * Gets the previous hash of the last block in the chain.
   * @returns {string} The previous hash of the last block, or an empty string if the chain is empty.
   * Complexity: O(1)
   */
  // eslint-disable-next-line getter-return
  get lastPrevBlockHash(): string | undefined {
    if (this._tail) {
      return this._tail.block.previousblockhash;
    }
  }

  /**
   * Gets the hash of the last block in the chain.
   * @returns {string} The hash of the last block, or an empty string if the chain is empty.
   * Complexity: O(1)
   */
  // eslint-disable-next-line getter-return
  get lastBlockHash(): string | undefined {
    if (this._tail) {
      return this._tail.block.hash;
    }
  }

  /**
   * Gets the height of the last block in the chain.
   * @returns {number} The height of the last block, or this._baseBlockHeight if the chain is empty.
   * Complexity: O(1)
   */
  // eslint-disable-next-line getter-return
  get lastBlockHeight(): number | undefined {
    if (this._tail) {
      return this._tail.block.height;
    }
  }

  /**
   * Gets the size of the blockchain.
   * @returns {number} The number of blocks in the chain.
   * Complexity: O(1)
   */
  get size(): number {
    return this._size;
  }

  /**
   * Adds a block to the end of the chain without validation.
   * @param block - The block to add.
   * @returns {boolean} True if the block was added successfully, false otherwise.
   * Complexity: O(1)
   */
  private addBlockFast(block: LightBlock): boolean {
    const newNode: Chain = { block, next: null, prev: this._tail };

    if (this._tail) {
      this._tail.next = newNode;
    }
    this._tail = newNode;

    if (!this._head) {
      this._head = newNode;
    }

    // Add to height index for O(1) lookup
    this.heightIndex.set(block.height, newNode);
    this._size++;

    // Remove the oldest block if the chain size exceeds the maximum allowed size
    if (this._size > this._maxSize) {
      this.removeOldestChain();
    }

    return true;
  }

  /**
   * Adds a block to the end of the chain.
   * @param block - The block to add.
   * @returns {boolean} True if the block was added successfully, false otherwise.
   * Complexity: O(1)
   */
  public addBlock(block: LightBlock): boolean {
    // Chain sequence validation (existing method)
    if (!this.validateNextBlock(block.height, block.previousblockhash)) {
      return false;
    }

    return this.addBlockFast(block);
  }

  /**
   * Adds an array of blocks to the chain.
   * @param {LightBlock[]} blocks - Array of blocks to add.
   * @returns {boolean} True if the blocks were added successfully, false otherwise.
   * Complexity: O(n), where n - is the number of blocks in the array
   */
  public addBlocks(blocks: LightBlock[]): boolean {
    // Chain sequence validation
    if (!this.validateNextBlocks(blocks)) {
      return false;
    }

    // Add all blocks fast
    for (const block of blocks) {
      this.addBlockFast(block);
    }

    return true;
  }

  /**
   * Gets the last block without deleting it.
   * @returns {LightBlock | null} The last block in the chain, or null if the chain is empty.
   * Complexity: O(1)
   */
  public peekLast(): LightBlock | null {
    return this._tail ? this._tail.block : null;
  }

  /**
   * Validates the next block to be added to the chain.
   * @param {number} height - The height of the new block.
   * @param {string} previousblockhash - The hash of the previous block.
   * @returns {boolean} True if the block is valid, false otherwise.
   * Complexity: O(1)
   */
  public validateNextBlock(height: number, previousblockhash: string): boolean {
    if (!this._tail) {
      // If there are no blocks in the chain, any block can be added as the starting point
      return true;
    }

    // Check if the given height is exactly one more than the last block's height.
    if (this._tail.block.height + 1 !== height) {
      return false;
    }

    // Check if the given previous hash matches the last block's hash.
    if (this._tail.block.hash !== previousblockhash) {
      return false;
    }

    return true;
  }

  /**
   * Validates an array of blocks to be added to the chain.
   * Ensures that the blocks are in the correct order and can be added sequentially.
   * @param {LightBlock[]} blocks - Array of blocks to validate.
   * @returns {boolean} True if all blocks are valid and in the correct order, false otherwise.
   * Complexity: O(n), where n - is the number of blocks in the array
   */
  public validateNextBlocks(blocks: LightBlock[]): boolean {
    if (blocks.length === 0) {
      return false; // Empty array is invalid
    }

    // Check if the first block in the array can be added to the current chain
    const firstBlock = blocks[0];
    if (!this.validateNextBlock(firstBlock!.height, firstBlock!.previousblockhash)) {
      return false; // First block doesn't fit into the current chain
    }

    // Now validate the rest of the blocks in the array to ensure they form a proper sequence
    for (let i = 1; i < blocks.length; i++) {
      const prevBlock = blocks[i - 1];
      const currentBlock = blocks[i];

      if (currentBlock!.height !== prevBlock!.height + 1 || currentBlock!.previousblockhash !== prevBlock!.hash) {
        return false; // Sequence or hash mismatch within the provided blocks
      }
    }

    return true; // All blocks are valid and in the correct order
  }

  /**
   * Truncates the blockchain up to a specified block height (inclusive).
   * The block with the given height becomes the new tail of the chain.
   *
   * @param {number} height - The height up to which the chain should be truncated.
   *                          Passing this._baseBlockHeight will clear the entire chain.
   * @returns {boolean} Returns `true` if truncation was successful or the chain is already in the desired state, `false` otherwise.
   * Complexity O(n), where n is the number of blocks to check from the tail to the specified height.
   */
  public truncateToBlock(height: number): boolean {
    if (height < this._baseBlockHeight) {
      // Invalid height value
      return false;
    }

    if (height === this._baseBlockHeight) {
      // Special case: clearing the entire chain
      if (this._head) {
        this._head = null;
        this._tail = null;
        this._size = 0;
        this.heightIndex.clear();
        return true;
      }
      // Chain is already empty
      return true;
    }

    if (!this._tail) {
      // Chain is empty and height is not this._baseBlockHeight
      // Cannot truncate to a specific height
      return false;
    }

    // If the desired height is the current last block's height, no action needed
    if (this._tail.block.height === height) {
      return true;
    }

    let currentNode: Chain | null = this._tail;
    let found = false;
    let nodesRemoved = 0;
    const removedHeights: number[] = [];

    // Traverse from the tail to find the block with the given height
    while (currentNode) {
      if (currentNode.block.height === height) {
        // Found the block to truncate to
        found = true;
        break;
      }
      removedHeights.push(currentNode.block.height);
      nodesRemoved++;
      currentNode = currentNode.prev;
    }

    if (!found) {
      // Height not found
      // If the specified height is less than the head's height, attempt to clear the chain
      const currentHeadHeight = this._head?.block.height ?? Infinity;
      if (height < currentHeadHeight) {
        if (this._head) {
          // Only clear the chain if it's not already empty
          this._head = null;
          this._tail = null;
          this._size = 0;
          this.heightIndex.clear();
          return true;
        }
      }
      // Height not found and does not require clearing
      return false;
    }

    // Remove heights from index
    for (const removedHeight of removedHeights) {
      this.heightIndex.delete(removedHeight);
    }

    // At this point, currentNode is guaranteed to be a Chain (not null)
    // Use a type assertion to inform TypeScript
    this._tail = currentNode as Chain;
    this._tail.next = null;
    this._size -= nodesRemoved;

    // Update the head if the chain size is now one
    if (this._size === 1) {
      this._head = this._tail;
    }

    return true;
  }

  /**
   * Validates the entire blockchain.
   * @returns {boolean} True if the blockchain is valid, false otherwise.
   * Complexity: O(n), where n - is the number of blocks in the chain
   */
  public validateChain(): boolean {
    let current = this._head;

    if (!current) {
      // An empty chain is considered valid
      return true;
    }

    while (current && current.next) {
      const nextBlock = current.next.block;

      // Check if the block heights increment by 1
      if (nextBlock.height !== current.block.height + 1) {
        return false; // Height mismatch
      }

      // Check if the previousblockhash matches the hash of the current block
      if (nextBlock.previousblockhash !== current.block.hash) {
        return false; // Hash mismatch
      }

      current = current.next;
    }

    // Ensure that the traversal ended at the tail
    return current === this._tail;
  }

  /**
   * Validates that the provided block data matches the last block in the chain.
   * @param {number} height - The expected height of the last block.
   * @param {string} hash - The expected hash of the last block.
   * @param {string} previousblockhash - The expected previous hash of the last block.
   * @returns {boolean} True if the provided data matches the last block, false otherwise.
   * NOTE: This method is needed for the case when we confirm the indexing of a block
   * in another command to make sure that the block we are passing exactly matches the chain
   * Complexity: O(1)
   */
  public validateLastBlock(height: number, hash: string, previousblockhash: string): boolean {
    if (!this._tail) {
      // If there are no blocks in the chain, any block can be considered a valid starting point
      return true;
    }

    // Check that the height of the last block matches the passed height.
    if (this._tail.block.height !== height) {
      return false;
    }

    // Check that the hash of the last block matches the passed hash
    if (this._tail.block.hash !== hash) {
      return false; // Hash mismatch
    }

    // Check that the previous hash of the last block matches the previous hash passed in.
    if (this._tail.block.previousblockhash !== previousblockhash) {
      return false;
    }

    return true;
  }

  /**
   * Finds a block by its height using O(1) index lookup.
   * @param {number} height - The height of the block to find.
   * @returns {LightBlock | null} The block, or null if not found.
   * Complexity: O(1) - constant time lookup
   */
  public findBlockByHeight(height: number): LightBlock | null {
    const node = this.heightIndex.get(height);
    return node ? node.block : null;
  }

  /**
   * Removes the first block in the chain.
   * @returns {LightBlock | null} The removed block, or null if the chain is empty.
   * Complexity: O(1)
   */
  private removeOldestChain(): LightBlock | null {
    if (!this._head) return null;

    const block = this._head.block;

    // Remove from height index
    this.heightIndex.delete(block.height);

    this._head = this._head.next;

    if (this._head) {
      this._head.prev = null;
    } else {
      this._tail = null;
    }

    this._size--;
    return block;
  }

  /**
   * Gets the last N blocks from the blockchain in reverse order.
   * @param {number} n - The number of blocks to retrieve.
   * @returns {LightBlock[]} An array containing the last N blocks in the chain, in reverse order.
   * Complexity: O(n), where n - is the number of blocks to retrieve
   */
  public getLastNBlocks(n: number): LightBlock[] {
    if (n <= 0) {
      return [];
    }

    const blocks: LightBlock[] = [];
    let currentNode = this._tail;
    let count = 0;

    while (currentNode && count < n) {
      blocks.push(currentNode.block);
      currentNode = currentNode.prev;
      count++;
    }

    // Reverse the array to get the correct order
    return blocks.reverse();
  }

  /**
   * Converts the linked list of blocks into an ordered array of LightBlock objects.
   * @returns {LightBlock[]} An array containing all blocks in the blockchain from head to tail.
   * Complexity O(n) - where n is the number of blocks in the blockchain.
   */
  public toArray(): LightBlock[] {
    const blocks: LightBlock[] = [];
    let current = this._head;
    while (current) {
      blocks.push(current.block);
      current = current.next;
    }
    return blocks;
  }

  /**
   * Restores the linked list of blocks from an ordered array of LightBlock objects.
   * This method clears the current blockchain and rebuilds it from the provided array.
   * @param {LightBlock[]} blocks - An array of LightBlock objects to reconstruct the blockchain.
   * @returns {void}
   * Complexity O(n) - where n is the number of blocks in the provided array.
   */
  public fromArray(blocks: LightBlock[]): void {
    this._head = null;
    this._tail = null;
    this._size = 0;
    this.heightIndex.clear();

    for (const block of blocks) {
      const newNode: Chain = { block, next: null, prev: this._tail };

      if (this._tail) {
        this._tail.next = newNode;
      }
      this._tail = newNode;

      if (!this._head) {
        this._head = newNode;
      }

      // Add to height index
      this.heightIndex.set(block.height, newNode);
      this._size++;

      // Remove the oldest block if the chain size exceeds the maximum allowed size.
      if (this._size > this._maxSize) {
        this.removeOldestChain();
      }
    }
  }
}
