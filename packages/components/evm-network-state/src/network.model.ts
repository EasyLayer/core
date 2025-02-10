import { AggregateRoot } from '@easylayer/components/cqrs';
import { AppLogger } from '@easylayer/components/logger';
import {
  NetworkProviderService,
  LightBlock,
  Blockchain,
  restoreChainLinks,
} from '@easylayer/components/evm-network-provider';
import {
  EvmNetworkInitializedEvent,
  EvmNetworkBlocksAddedEvent,
  EvmNetworkReorganisationStartedEvent,
  EvmNetworkReorganisationFinishedEvent,
} from '@easylayer/common/domain-cqrs-components/evm';

export enum NetworkStatuses {
  AWAITING = 'awaiting',
  REORGANISATION = 'reorganisation',
}

export class Network extends AggregateRoot {
  private __maxSize!: number;
  // IMPORTANT: There must be only one Network Aggregate in the module,
  // so we immediately give it aggregateId by which we can find it.
  public aggregateId: string = 'network';
  public status: NetworkStatuses = NetworkStatuses.AWAITING;
  public chain: Blockchain;

  constructor({ maxSize }: { maxSize: number }) {
    super();

    this.__maxSize = maxSize;
    // IMPORTANT: 'maxSize' must be NOT LESS than the number of blocks in a single batch when iterating over BlocksQueue.
    // The number of blocks in a batch depends on the block size,
    // so we must take the smallest blocks in the network,
    // and make sure that they fit into a single batch less than the value of 'maxSize' .
    this.chain = new Blockchain({ maxSize });
  }

  protected toJsonPayload(): any {
    return {
      status: this.status,
      // Convert Blockchain to an array of blocks
      chain: this.chain.toArray(),
    };
  }

  protected fromSnapshot(state: any): void {
    this.status = state.status;
    if (state.chain && Array.isArray(state.chain)) {
      this.chain = new Blockchain({ maxSize: this.__maxSize });
      this.chain.fromArray(state.chain);
      // Recovering links in Blockchain
      restoreChainLinks(this.chain.head);
    }

    Object.setPrototypeOf(this, Network.prototype);
  }

  // IMPORTANT: this method doing two things:
  // 1 - create Network if it's first creation
  // 2 - truncate chain if chain last height bigger then startHeight
  public async init({
    requestId,
    indexedHeight,
    logger,
  }: {
    requestId: string;
    indexedHeight: number;
    logger: AppLogger;
  }) {
    // IMPORTANT: We always initialize the Network with the awaiting status,
    // if there was a reorganization status, then it will be processed at the next iteration.
    const status = NetworkStatuses.AWAITING;

    const height =
      this.chain.lastBlockHeight !== undefined
        ? indexedHeight < this.chain.lastBlockHeight
          ? indexedHeight
          : this.chain.lastBlockHeight
        : indexedHeight;

    logger.debug(
      'Init Network Aggregate',
      { writeStateLastHeight: height, readStateLastHeight: indexedHeight },
      this.constructor.name
    );

    await this.apply(
      new EvmNetworkInitializedEvent({
        aggregateId: this.aggregateId,
        requestId,
        status,
        indexedHeight: height.toString(),
      })
    );
  }

  public async addBlocks({
    blocks,
    requestId,
    service,
    logger,
  }: {
    blocks: any;
    requestId: string;
    service: any;
    logger: AppLogger;
  }) {
    if (this.status !== NetworkStatuses.AWAITING) {
      throw new Error("addBlocks() Reorganisation hasn't finished yet");
    }

    const isValid = this.chain.validateNextBlocks(blocks);

    if (!isValid) {
      return await this.startReorganisation({
        height: this.chain.lastBlockHeight!,
        requestId,
        service,
        blocks: [],
        logger,
      });
    }

    logger.debug('Add blocks', { blocksLength: blocks.length }, this.constructor.name);

    return await this.apply(
      new EvmNetworkBlocksAddedEvent({
        aggregateId: this.aggregateId,
        requestId,
        status: NetworkStatuses.AWAITING,
        blocks: blocks.map((block: any) => ({
          ...block,
          transactions: block.transactions.map((t: any) => t.txid),
        })),
      })
    );
  }

  public async startReorganisation({
    height,
    requestId,
    service,
    blocks,
    logger,
  }: {
    height: number;
    requestId: string;
    service: NetworkProviderService;
    blocks: any[];
    logger: AppLogger;
  }): Promise<void> {
    if (this.status !== NetworkStatuses.AWAITING) {
      throw new Error("reorganisation() Previous reorganisation hasn't finished yet");
    }

    const localBlock = this.chain.findBlockByHeight(height)!;
    const oldBlock = await service.getOneBlockByHeight(height);

    if (!localBlock) {
      throw new Error("Can't fetch local block");
    }

    if (!oldBlock) {
      throw new Error("Can't fetch old block");
    }

    if (oldBlock.hash === localBlock.hash && oldBlock.parentHash === localBlock.parentHash) {
      // Match found

      logger.debug('Start reorganisation', { height }, this.constructor.name);

      return await this.apply(
        new EvmNetworkReorganisationStartedEvent({
          aggregateId: this.aggregateId,
          requestId,
          status: NetworkStatuses.REORGANISATION,
          // IMPORTANT: height - is height of reorganisation(the last height where the blocks matched)
          height: height.toString(),
          // IMPORTANT: blocks that need to be reorganized
          blocks,
        })
      );
    }

    // Saving blocks for publication in an event
    const newBlocks = [...blocks, localBlock];
    const prevHeight = height - 1;

    // Recursive check the previous block
    return this.startReorganisation({ height: prevHeight, requestId, service, blocks: newBlocks, logger });
  }

  public async finishReorganisation({
    blocks,
    height,
    requestId,
    logger,
  }: {
    blocks: LightBlock[];
    height: string | number;
    requestId: string;
    logger: AppLogger;
  }): Promise<void> {
    if (this.status !== NetworkStatuses.REORGANISATION) {
      throw new Error("processReorganisation() Reorganisation hasn't started yet");
    }

    if (Number(height) > this.chain.lastBlockHeight!) {
      // IMPORTANT: In this case we just skip + we can log this error
      logger.warn(
        "Reorganization height is higher than Network's blockchain height",
        { reorganisationHeight: height, lastBlockchainHeight: this.chain.lastBlockHeight },
        this.constructor.name
      );
      return;
    }

    return await this.apply(
      new EvmNetworkReorganisationFinishedEvent({
        aggregateId: this.aggregateId,
        requestId,
        status: NetworkStatuses.AWAITING,
        // IMPORTANT: height - height of reorganization (last correct block)
        height: height.toString(),
        blocks,
      })
    );
  }

  private onEvmNetworkInitializedEvent({ payload }: EvmNetworkInitializedEvent) {
    const { aggregateId, status, indexedHeight } = payload;
    this.aggregateId = aggregateId;
    this.status = status as NetworkStatuses;

    // IMPORTANT: In cases of blockchain synchronization with the read state,
    // we truncate the model to the precisely processed height.
    this.chain.truncateToBlock(Number(indexedHeight));
  }

  private onEvmNetworkBlocksAddedEvent({ payload }: EvmNetworkBlocksAddedEvent) {
    const { blocks, status } = payload;

    this.status = status as NetworkStatuses;
    this.chain.addBlocks(
      blocks.map((block: any) => ({
        number: Number(block.number),
        hash: block.hash,
        parentHash: block?.parentHash || '',
        transactions: block.transactions.map((txid: any) => txid),
      }))
    );
  }

  private onEvmNetworkReorganisationStartedEvent({ payload }: EvmNetworkReorganisationStartedEvent) {
    const { status } = payload;
    this.status = status as NetworkStatuses;
  }

  // Here we cut full at once in height
  // This method is idempotent
  private onEvmNetworkReorganisationFinishedEvent({ payload }: EvmNetworkReorganisationFinishedEvent) {
    const { height, status } = payload;
    this.status = status as NetworkStatuses;
    this.chain.truncateToBlock(Number(height));
  }
}
