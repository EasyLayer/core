import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, LightBlock, Block, Transaction } from '../../blockchain-provider';
import { Blockchain } from '../../blockchain-provider';
import {
  EvmNetworkInitializedEvent,
  EvmNetworkBlocksAddedEvent,
  EvmNetworkReorganizedEvent,
  EvmNetworkClearedEvent,
} from '../events';
import { BlockchainValidationError } from './errors';

/**
 * Network for EVM blockchain storage with fast height lookups.
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

  // Getter for current block height in the chain
  public get currentBlockHeight(): number | undefined {
    return this.chain.lastBlockHeight;
  }

  /**
   * Gets current chain statistics
   * Complexity: O(1)
   */
  public getChainStats(): {
    size: number;
    maxSize: number;
    currentHeight?: number;
    firstHeight?: number;
    isEmpty: boolean;
    isFull: boolean;
  } {
    return {
      size: this.chain.size,
      maxSize: this.__maxSize,
      currentHeight: this.chain.lastBlockHeight,
      firstHeight: this.chain.head?.block.blockNumber,
      isEmpty: this.chain.size === 0,
      isFull: this.chain.size >= this.__maxSize,
    };
  }

  /**
   * Gets the last block in chain
   * Complexity: O(1)
   */
  public getLastBlock(): LightBlock | undefined {
    return this.chain.lastBlock;
  }

  /**
   * Gets specific block by height
   * Complexity: O(n) where n = number of blocks in chain
   */
  public getBlockByHeight(height: number): LightBlock | null {
    return this.chain.findBlockByHeight(height);
  }

  /**
   * Gets last N blocks in chronological order
   * Complexity: O(n) where n = requested count
   */
  public getLastNBlocks(count: number): LightBlock[] {
    return this.chain.getLastNBlocks(count);
  }

  /**
   * Gets all blocks in chain
   * Complexity: O(n) where n = number of blocks in chain
   */
  public getAllBlocks(): LightBlock[] {
    return this.chain.toArray();
  }

  protected toJsonPayload(): any {
    return {
      // Convert Blockchain to an array of blocks for serialization
      chain: this.chain.toArray(),
      maxSize: this.__maxSize,
    };
  }

  protected fromSnapshot(state: any): void {
    if (state.chain && Array.isArray(state.chain)) {
      this.chain = new Blockchain({
        maxSize: state.maxSize || this.__maxSize,
        baseBlockHeight: this._lastBlockHeight,
      });
      this.chain.fromArray(state.chain);
    }

    Object.setPrototypeOf(this, Network.prototype);
  }

  public async init({ requestId, startHeight }: { requestId: string; startHeight: number }) {
    await this.apply(
      new EvmNetworkInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: startHeight,
      })
    );
  }

  // Method to clear all blockchain data(for database cleaning)
  public async clearChain({ requestId }: { requestId: string }) {
    await this.apply(
      new EvmNetworkClearedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: -1,
      })
    );
  }

  public async addBlocks({ blocks, requestId }: { blocks: LightBlock[]; requestId: string }) {
    if (!this.chain.validateNextBlocks(blocks)) {
      throw new BlockchainValidationError();
    }

    return await this.apply(
      new EvmNetworkBlocksAddedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: blocks[blocks.length - 1]?.blockNumber ?? -1,
        blocks,
      })
    );
  }

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
      throw new Error('Reorganisation failed: reached genesis without fork point');
    }

    // Get both blocks at once
    const localBlock = this.chain.findBlockByHeight(reorgHeight);
    const remoteBlock = await service.getOneBlockByHeight(reorgHeight);

    // Handle all possible null/undefined combinations
    const hasLocal = localBlock != null; // covers both null and undefined
    const hasRemote = remoteBlock != null; // covers both null and undefined

    // Case 1: Fork point found - both blocks exist and match
    if (hasLocal && hasRemote) {
      const isForkPoint = remoteBlock.hash === localBlock.hash && remoteBlock.parentHash === localBlock.parentHash;

      if (isForkPoint) {
        return await this.apply(
          new EvmNetworkReorganizedEvent({
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

  private onEvmNetworkInitializedEvent({ payload }: EvmNetworkInitializedEvent) {
    const { blockHeight } = payload;

    // IMPORTANT: In cases where the user specified a height less
    // than what was already saved in the model
    this.chain.truncateToBlock(Number(blockHeight));
  }

  private onEvmNetworkBlocksAddedEvent({ payload }: EvmNetworkBlocksAddedEvent) {
    const { blocks } = payload;

    // To make this method idempotent: check if the last incoming block is already present
    const incomingLastHash = blocks[blocks.length - 1]!.hash;
    if (incomingLastHash === this.chain.lastBlockHash) {
      // Blocks already added, nothing to do
      return;
    }

    this.chain.addBlocks(
      blocks.map((block: LightBlock) => ({
        blockNumber: Number(block.blockNumber),
        hash: block.hash,
        parentHash: block?.parentHash || '',
        transactions: block.transactions,
        receipts: block.receipts,
        transactionsRoot: block.transactionsRoot,
        receiptsRoot: block.receiptsRoot,
        stateRoot: block.stateRoot,
      }))
    );
  }

  private onEvmNetworkReorganizedEvent({ payload }: EvmNetworkReorganizedEvent) {
    const { blockHeight } = payload;
    // Here we cut full at once in height
    // This method is idempotent
    this.chain.truncateToBlock(Number(blockHeight));
  }

  private onEvmNetworkClearedEvent({ payload }: EvmNetworkClearedEvent) {
    this.chain.truncateToBlock(-1);
  }
}
