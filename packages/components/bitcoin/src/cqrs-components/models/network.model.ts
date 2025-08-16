import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, LightBlock, Block, Transaction } from '../../blockchain-provider';
import { Blockchain } from '../../blockchain-provider';
import {
  BitcoinNetworkInitializedEvent,
  BitcoinNetworkBlocksAddedEvent,
  BitcoinNetworkReorganizedEvent,
  BitcoinNetworkClearedEvent,
} from '../events';
import { BlockchainValidationError, ReorganizationGenesisError } from './errors';

/**
 * Network aggregate for blockchain storage with fast height lookups
 *
 * Memory Strategy:
 * - Circular buffer storage with O(1) height-based lookups
 * - Stores ~32-128KB per LightBlock (200 bytes base + tx_count × 64 bytes per txid)
 * - Hash-based indexing for fast block retrieval
 * - Automatic pruning when maxSize exceeded
 *
 * Performance:
 * - Block lookup by height: O(1) constant time
 * - Block addition: O(1) amortized
 * - Reorganization: O(d) where d = depth of reorg
 * - Chain validation: O(n) where n = number of blocks
 *
 * Memory Usage Estimation:
 * - LightBlock storage: ~32-128KB per block (depends on tx count)
 * - Height index: ~8 bytes per block
 * - Hash mappings: ~40 bytes per block
 * - Total: ~32-128KB per block × maxSize
 */
export class Network extends AggregateRoot {
  private __maxSize: number;
  public chain: Blockchain;

  constructor({
    maxSize,
    aggregateId,
    blockHeight,
    options,
  }: {
    maxSize: number;
    aggregateId: string;
    blockHeight: number;
    options?: {
      snapshotsEnabled?: boolean;
      allowPruning?: boolean;
      snapshotInterval?: number;
    };
  }) {
    super(aggregateId, blockHeight, options);

    this.__maxSize = maxSize;
    // IMPORTANT: 'maxSize' must be NOT LESS than the number of blocks in a single batch when iterating over BlocksQueue.
    // The number of blocks in a batch depends on the block size,
    // so we must take the smallest blocks in the network,
    // and make sure that they fit into a single batch less than the value of 'maxSize' .
    this.chain = new Blockchain({ maxSize, baseBlockHeight: blockHeight });
  }

  // ===== GETTERS =====

  /**
   * Getter for current block height in the chain
   * Time complexity: O(1)
   */
  public get currentBlockHeight(): number | undefined {
    return this.chain.lastBlockHeight;
  }

  /**
   * Gets current chain statistics
   * Time complexity: O(1)
   * Memory: Creates small statistics object (~200 bytes)
   */
  public getChainStats(): {
    size: number;
    maxSize: number;
    currentHeight?: number;
    firstHeight?: number;
    isEmpty: boolean;
    isFull: boolean;
    memoryUsage: {
      estimatedBytes: number;
      blocksStorageBytes: number;
      indexingBytes: number;
    };
  } {
    const firstBlock = this.chain.toArray()[0]; // This is O(1) since we just get head
    const size = this.chain.size;

    // Estimate memory usage - LightBlock: ~200 bytes base + (tx_count × 64 bytes)
    // Average block: ~200 + (1500 × 64) = ~96KB per block
    const blocksStorageBytes = size * 96 * 1024; // ~96KB per block average
    const indexingBytes = size * 48; // ~48 bytes per block for indexing
    const estimatedBytes = blocksStorageBytes + indexingBytes;

    return {
      size,
      maxSize: this.__maxSize,
      currentHeight: this.chain.lastBlockHeight,
      firstHeight: firstBlock?.height,
      isEmpty: size === 0,
      isFull: size >= this.__maxSize,
      memoryUsage: {
        estimatedBytes,
        blocksStorageBytes,
        indexingBytes,
      },
    };
  }

  /**
   * Gets the last block in chain
   * Time complexity: O(1)
   */
  public getLastBlock(): LightBlock | undefined {
    return this.chain.lastBlock;
  }

  /**
   * Gets specific block by height using O(1) hash lookup
   * Time complexity: O(1) - constant time lookup
   */
  public getBlockByHeight(height: number): LightBlock | null {
    return this.chain.findBlockByHeight(height);
  }

  /**
   * Gets last N blocks in chronological order
   * Time complexity: O(n) where n = requested count
   * Memory: Creates new array with n block references
   */
  public getLastNBlocks(count: number): LightBlock[] {
    return this.chain.getLastNBlocks(count);
  }

  /**
   * Gets all blocks in chain (for compatibility - try to avoid for large chains)
   * Time complexity: O(n) where n = number of blocks in chain
   * Memory: Creates new array with all block references (~n × 8 bytes)
   */
  public getAllBlocks(): LightBlock[] {
    return this.chain.toArray();
  }

  /**
   * Gets blocks in height range (inclusive)
   * Time complexity: O(r) where r = number of blocks in range
   * Memory: Creates new array with r block references
   */
  public getBlocksInRange(startHeight: number, endHeight: number): LightBlock[] {
    const blocks: LightBlock[] = [];

    for (let height = startHeight; height <= endHeight; height++) {
      const block = this.chain.findBlockByHeight(height);
      if (block) {
        blocks.push(block);
      }
    }

    return blocks;
  }

  /**
   * Check if block exists at specific height
   * Time complexity: O(1)
   */
  public hasBlockAtHeight(height: number): boolean {
    return this.chain.findBlockByHeight(height) !== null;
  }

  /**
   * Get block hash by height
   * Time complexity: O(1)
   */
  public getBlockHashByHeight(height: number): string | null {
    const block = this.chain.findBlockByHeight(height);
    return block ? block.hash : null;
  }

  /**
   * Get height range currently stored in chain
   * Time complexity: O(1)
   */
  public getHeightRange(): { min?: number; max?: number; count: number } {
    const blocks = this.chain.toArray();
    if (blocks.length === 0) {
      return { count: 0 };
    }

    const heights = blocks.map((b) => b.height).sort((a, b) => a - b);
    return {
      min: heights[0],
      max: heights[heights.length - 1],
      count: blocks.length,
    };
  }

  // ===== SNAPSHOTS =====

  protected toJsonPayload(): any {
    return {
      // Convert Blockchain to an array of blocks for serialization
      chain: this.chain.toArray(),
      maxSize: this.__maxSize,
    };
  }

  protected fromSnapshot(state: any): void {
    // Safety check for state
    if (!state || typeof state !== 'object') {
      return;
    }

    // Safe restore with type checking
    this.__maxSize = typeof state.maxSize === 'number' ? state.maxSize : this.__maxSize;

    if (state.chain && Array.isArray(state.chain)) {
      this.chain = new Blockchain({
        maxSize: this.__maxSize,
        baseBlockHeight: this._lastBlockHeight,
      });
      this.chain.fromArray(state.chain);
    }

    Object.setPrototypeOf(this, Network.prototype);
  }

  // ===== PUBLIC COMMAND METHODS =====

  /**
   * Initialize network with starting height
   * Time complexity: O(1)
   */
  public async init({ requestId, startHeight }: { requestId: string; startHeight: number }) {
    // Event payload size estimation: ~1KB (minimal data)
    await this.apply(
      new BitcoinNetworkInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: startHeight,
      })
    );
  }

  /**
   * Method to clear all blockchain data (for database cleaning)
   * Time complexity: O(1)
   */
  public async clearChain({ requestId }: { requestId: string }) {
    // Event payload size estimation: ~1KB (minimal data)
    await this.apply(
      new BitcoinNetworkClearedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: -1,
      })
    );
  }

  /**
   * Add blocks to the chain with validation
   * Time complexity: O(n) where n = number of blocks to validate
   * Memory: stores blocks in circular buffer (~32-128KB per block depending on tx count)
   */
  public async addBlocks({ blocks, requestId }: { blocks: LightBlock[]; requestId: string }) {
    if (!this.chain.validateNextBlocks(blocks)) {
      throw new BlockchainValidationError();
    }

    // Event payload size estimation:
    // - blocks: ~100 blocks × 96KB = ~9.6MB per batch (average case)
    // Total event size: ~9.6MB per blocks batch
    return await this.apply(
      new BitcoinNetworkBlocksAddedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: blocks[blocks.length - 1]?.height || -1,
        blocks,
      })
    );
  }

  /**
   * Handle blockchain reorganization
   * Time complexity: O(d) where d = depth of reorganization
   * Memory: accumulates reorg blocks in array (~d × 32-128KB per block)
   */
  public async reorganisation({
    reorgHeight,
    requestId,
    service,
    blocks,
  }: {
    reorgHeight: number;
    requestId: string;
    service: BlockchainProviderService;
    blocks: LightBlock[];
  }): Promise<void> {
    // Base case: gone below zero - nowhere else to go
    if (reorgHeight < 0) {
      throw new ReorganizationGenesisError();
    }

    // Get both blocks at once - using O(1) lookup for local block
    const localBlock = this.chain.findBlockByHeight(reorgHeight);
    const remoteBlock = await service.getBasicBlockByHeight(reorgHeight);

    // Handle all possible null/undefined combinations
    const hasLocal = localBlock != null; // covers both null and undefined
    const hasRemote = remoteBlock != null; // covers both null and undefined

    // Case 1: Fork point found - both blocks exist and match
    if (hasLocal && hasRemote) {
      const isForkPoint =
        remoteBlock.hash === localBlock.hash && remoteBlock.previousblockhash === localBlock.previousblockhash;

      if (isForkPoint) {
        // Event payload size estimation:
        // - blocks: ~d blocks × 96KB where d = reorg depth
        // Total event size: ~d × 96KB per reorganization
        return await this.apply(
          new BitcoinNetworkReorganizedEvent({
            aggregateId: this.aggregateId,
            blockHeight: reorgHeight,
            requestId,
            blocks,
          })
        );
      }
    }

    // Case 2: Continue searching deeper
    // Add local block to reorg list only if it exists
    const newBlocks = hasLocal ? [...blocks, localBlock] : blocks;

    return this.reorganisation({
      reorgHeight: reorgHeight - 1,
      requestId,
      service,
      blocks: newBlocks,
    });
  }

  // ===== IDEMPOTENT EVENT HANDLERS =====

  private onBitcoinNetworkInitializedEvent({ payload }: BitcoinNetworkInitializedEvent) {
    const { blockHeight } = payload;

    // IMPORTANT: In cases where the user specified a height less
    // than what was already saved in the model
    this.chain.truncateToBlock(Number(blockHeight));
  }

  private onBitcoinNetworkBlocksAddedEvent({ payload }: BitcoinNetworkBlocksAddedEvent) {
    const { blocks } = payload;

    // To make this method idempotent: check if the last incoming block is already present
    const incomingLastHash = blocks[blocks.length - 1]!.hash;
    if (incomingLastHash === this.chain.lastBlockHash) {
      // Blocks already added, nothing to do
      return;
    }

    this.chain.addBlocks(
      blocks.map((block: LightBlock) => ({
        height: Number(block.height),
        hash: block.hash,
        merkleroot: block.merkleroot,
        previousblockhash: block?.previousblockhash || '',
        tx: block.tx.map((txid: string) => txid),
      }))
    );
  }

  private onBitcoinNetworkReorganizedEvent({ payload }: BitcoinNetworkReorganizedEvent) {
    const { blockHeight } = payload;
    // Here we cut full at once in height
    // This method is idempotent
    this.chain.truncateToBlock(Number(blockHeight));
  }

  private onBitcoinNetworkClearedEvent({ payload }: BitcoinNetworkClearedEvent) {
    this.chain.truncateToBlock(-1); // Clear all blocks
  }
}
