import type { Logger } from '@nestjs/common';
import { AggregateRoot } from '@easylayer/common/cqrs';
import type { BlockchainProviderService } from '../../../blockchain-provider/blockchain-provider.service';
import type { LightBlock, Block } from '../../../blockchain-provider/components/block.interfaces';
import { Blockchain } from './blockchain.structure';
import {
  EvmNetworkInitializedEvent,
  EvmNetworkBlocksAddedEvent,
  EvmNetworkReorganizedEvent,
  EvmNetworkClearedEvent,
} from '../../events/network';
import { BlockchainValidationError } from '../errors';

/**
 * Network aggregate for EVM blockchain storage.
 *
 * Memory Strategy: circular buffer with O(1) height lookups.
 * Stores LightBlock (hashes only) — no transaction bodies, no receipts.
 *
 * lastBlockHeight is intentionally NOT overridden here.
 * It is managed exclusively by AggregateRoot (via events blockHeight field),
 * which is the same pattern as the Bitcoin Network aggregate.
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
    options?: { snapshotsEnabled?: boolean; allowPruning?: boolean; snapshotInterval?: number };
  }) {
    super(aggregateId, blockHeight, options);
    this.__maxSize = maxSize;
    this.chain = new Blockchain({ maxSize, baseBlockHeight: blockHeight });
  }

  // ===== GETTERS =====

  public getLastBlock(): LightBlock | undefined {
    return this.chain.lastBlock;
  }
  public getBlockByHeight(height: number): LightBlock | null {
    return this.chain.findBlockByHeight(height);
  }
  public getLastNBlocks(count: number): LightBlock[] {
    return this.chain.getLastNBlocks(count);
  }
  public getAllBlocks(): LightBlock[] {
    return this.chain.toArray();
  }

  // ===== SNAPSHOTS =====

  protected serializeUserState(): Record<string, any> {
    return { maxSize: this.__maxSize, chain: this.chain.toArray() };
  }

  protected restoreUserState(state: any): void {
    if (typeof state?.maxSize === 'number') this.__maxSize = state.maxSize;
    this.chain = new Blockchain({ maxSize: this.__maxSize, baseBlockHeight: super.lastBlockHeight });
    if (Array.isArray(state?.chain)) this.chain.fromArray(state.chain);
    Object.setPrototypeOf(this, Network.prototype);
  }

  // ===== COMMANDS =====

  public async init({
    requestId,
    startHeight,
    currentNetworkHeight,
    logger,
  }: {
    requestId: string;
    startHeight: number;
    currentNetworkHeight: number;
    logger?: Logger;
  }): Promise<void> {
    this.apply(
      new EvmNetworkInitializedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: startHeight }, {})
    );

    logger?.log('Network successfully initialized', {
      module: 'network-model',
      args: {
        lastIndexedHeight: startHeight,
        nextBlockToProcess: startHeight + 1,
        currentNetworkHeight,
      },
    });
  }

  public async clearChain({ requestId }: { requestId: string }): Promise<void> {
    this.apply(new EvmNetworkClearedEvent({ aggregateId: this.aggregateId, requestId, blockHeight: -1 }, {}));
  }

  public async addBlocks({
    blocks,
    requestId,
    logger,
  }: {
    blocks: LightBlock[];
    requestId: string;
    logger?: Logger;
  }): Promise<void> {
    if (!this.chain.validateNextBlocks(blocks)) {
      throw new BlockchainValidationError();
    }

    const blockHeight = blocks[blocks.length - 1]?.blockNumber ?? -1;

    this.apply(
      new EvmNetworkBlocksAddedEvent(
        {
          aggregateId: this.aggregateId,
          requestId,
          blockHeight,
        },
        { blocks }
      )
    );

    logger?.log('Blocks successfully added', {
      module: 'network-model',
      args: { blockHeight },
    });
  }

  public async reorganisation({
    reorgHeight,
    requestId,
    service,
    blocks,
    logger,
  }: {
    reorgHeight: number;
    requestId: string;
    service: BlockchainProviderService;
    blocks: LightBlock[];
    logger?: Logger;
  }): Promise<void> {
    if (reorgHeight < 0) {
      throw new Error('Reorganisation failed: reached genesis without fork point');
    }

    const localBlock = this.chain.findBlockByHeight(reorgHeight);
    const remoteBlock = await service.getOneBlockByHeight(reorgHeight);

    const hasLocal = localBlock != null;
    const hasRemote = remoteBlock != null;

    if (hasLocal && hasRemote) {
      const isFork = remoteBlock.hash === localBlock.hash && remoteBlock.parentHash === localBlock.parentHash;
      if (isFork) {
        this.apply(
          new EvmNetworkReorganizedEvent(
            { aggregateId: this.aggregateId, blockHeight: reorgHeight, requestId },
            { blocks }
          )
        );

        logger?.log('Blocks successfully reorganized', {
          module: 'network-model',
          args: { blockHeight: reorgHeight },
        });

        return;
      }
    }

    const newBlocks = hasLocal ? [...blocks, localBlock] : blocks;
    return this.reorganisation({
      reorgHeight: reorgHeight - 1,
      requestId,
      service,
      blocks: newBlocks,
      logger,
    });
  }

  // ===== EVENT HANDLERS =====

  private onEvmNetworkInitializedEvent({ blockHeight }: EvmNetworkInitializedEvent): void {
    this.chain.truncateToBlock(Number(blockHeight));
  }

  private onEvmNetworkBlocksAddedEvent({ payload }: EvmNetworkBlocksAddedEvent): void {
    const { blocks } = payload;
    const incomingLastHash = blocks[blocks.length - 1]?.hash;
    if (incomingLastHash && incomingLastHash === this.chain.lastBlockHash) return; // idempotent

    this.chain.addBlocks(
      blocks.map((b: LightBlock) => ({
        blockNumber: Number(b.blockNumber),
        hash: b.hash,
        parentHash: b.parentHash || '',
        transactions: b.transactions,
        receipts: b.receipts,
        transactionsRoot: b.transactionsRoot,
        receiptsRoot: b.receiptsRoot,
        stateRoot: b.stateRoot,
      }))
    );
  }

  private onEvmNetworkReorganizedEvent({ blockHeight }: EvmNetworkReorganizedEvent): void {
    this.chain.truncateToBlock(Number(blockHeight));
  }

  private onEvmNetworkClearedEvent(_: EvmNetworkClearedEvent): void {
    this.chain.truncateToBlock(-1);
  }
}
