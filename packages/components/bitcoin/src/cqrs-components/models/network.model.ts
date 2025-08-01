import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, LightBlock, Block, Transaction } from '../../blockchain-provider';
import { Blockchain, restoreChainLinks } from '../../blockchain-provider';
import {
  BitcoinNetworkInitializedEvent,
  BitcoinNetworkBlocksAddedEvent,
  BitcoinNetworkReorganizedEvent,
  BitcoinNetworkClearedEvent,
} from '../events';
import { BlockchainValidationError } from './errors';

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
      pruneOldSnapshots?: boolean;
      allowEventsPruning?: boolean;
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
      firstHeight: this.chain.head?.block.height,
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
      // Convert Blockchain to an array of blocks
      chain: this.chain.toArray(),
    };
  }

  protected fromSnapshot(state: any): void {
    if (state.chain && Array.isArray(state.chain)) {
      this.chain = new Blockchain({
        maxSize: this.__maxSize,
        baseBlockHeight: this._lastBlockHeight,
      });
      this.chain.fromArray(state.chain);
      // Recovering links in Blockchain
      restoreChainLinks(this.chain.head);
    }

    Object.setPrototypeOf(this, Network.prototype);
  }

  public async init({ requestId, startHeight }: { requestId: string; startHeight: number }) {
    await this.apply(
      new BitcoinNetworkInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: startHeight,
      })
    );
  }

  // Method to clear all blockchain data(for database cleaning)
  public async clearChain({ requestId }: { requestId: string }) {
    await this.apply(
      new BitcoinNetworkClearedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: -1,
      })
    );
  }

  public async addBlocks({ blocks, requestId }: { blocks: Block[]; requestId: string }) {
    const lightBlocks: LightBlock[] = blocks.map((block: Block) => ({
      height: block.height,
      hash: block.hash,
      previousblockhash: block.previousblockhash ?? '',
      tx: (block.tx ?? []).map((tx: Transaction) => tx.hash),
    }));

    const isValid = this.chain.validateNextBlocks(lightBlocks);

    if (!isValid) {
      throw new BlockchainValidationError();
    }

    return await this.apply(
      new BitcoinNetworkBlocksAddedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: blocks[blocks.length - 1]?.height ?? -1,
        blocks: lightBlocks,
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
    const remoteBlock = await service.getBasicBlockByHeight(reorgHeight);

    // Handle all possible null/undefined combinations
    const hasLocal = localBlock != null; // covers both null and undefined
    const hasRemote = remoteBlock != null; // covers both null and undefined

    // Case 1: Fork point found - both blocks exist and match
    if (hasLocal && hasRemote) {
      const isForkPoint =
        remoteBlock.hash === localBlock.hash && remoteBlock.previousblockhash === localBlock.previousblockhash;

      if (isForkPoint) {
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
