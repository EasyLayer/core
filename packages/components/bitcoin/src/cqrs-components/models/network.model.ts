import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService, LightBlock, Block, Transaction } from '../../blockchain-provider';
import { Blockchain, restoreChainLinks } from '../../blockchain-provider';
import {
  BitcoinNetworkInitializedEvent,
  BitcoinNetworkBlocksAddedEvent,
  BitcoinNetworkReorganizedEvent,
} from '../events';
import { BlockchainValidationError } from './errors';

export class Network extends AggregateRoot {
  private __maxSize: number;
  public chain: Blockchain;

  constructor({ maxSize, aggregateId }: { maxSize: number; aggregateId: string }) {
    super(aggregateId);

    this.__maxSize = maxSize;
    // IMPORTANT: 'maxSize' must be NOT LESS than the number of blocks in a single batch when iterating over BlocksQueue.
    // The number of blocks in a batch depends on the block size,
    // so we must take the smallest blocks in the network,
    // and make sure that they fit into a single batch less than the value of 'maxSize' .
    this.chain = new Blockchain({ maxSize });
  }

  protected toJsonPayload(): any {
    return {
      // Convert Blockchain to an array of blocks
      chain: this.chain.toArray(),
    };
  }

  protected fromSnapshot(state: any): void {
    if (state.chain && Array.isArray(state.chain)) {
      this.chain = new Blockchain({ maxSize: this.__maxSize });
      this.chain.fromArray(state.chain);
      // Recovering links in Blockchain
      restoreChainLinks(this.chain.head);
    }

    Object.setPrototypeOf(this, Network.prototype);
  }

  public async init({ requestId, startHeight }: { requestId: string; startHeight: number }) {
    const last = this.chain.lastBlockHeight;
    const height =
      last != null
        ? // if there is already a height, we take the maximum between the current and starting
          Math.max(last, startHeight)
        : // if the chain is empty, we put it on the “pre-start” block
          startHeight - 1;

    await this.apply(
      new BitcoinNetworkInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        blockHeight: height,
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

    const localBlock = this.chain.findBlockByHeight(reorgHeight);
    const oldBlock = await service.getOneBlockByHeight(reorgHeight);

    const isForkPoint =
      oldBlock != null &&
      localBlock != null &&
      oldBlock.hash === localBlock.hash &&
      oldBlock.previousblockhash === localBlock.previousblockhash;

    if (isForkPoint) {
      // Match found
      return await this.apply(
        new BitcoinNetworkReorganizedEvent({
          aggregateId: this.aggregateId,
          blockHeight: reorgHeight,
          requestId,
          blocks,
        })
      );
    }

    // In other cases, we go down
    const newBlocks = localBlock ? [...blocks, localBlock] : blocks;

    // Recursive call to the lower level
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
}
