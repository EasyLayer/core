import { NetworkProviderService } from '@easylayer/components/bitcoin-network-provider';
import { AppLogger, RuntimeTracker } from '@easylayer/components/logger';
import { BlocksLoadingStrategy, StrategyNames } from './load-strategy.interface';
import { Block } from '../../interfaces';
import { BlocksQueue } from '../../blocks-queue';

interface BlockInfo {
  hash: string;
  size: number;
  height: number;
}

export class PullNetworkProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.PULL_NETWORK_PROVIDER;
  private _maxRequestBlocksBatchSize: number = 10 * 1024 * 1024; // Batch size in bytes
  private _concurrency: number = 1;
  private _preloadedItemsQueue: BlockInfo[] = [];
  private isTest: boolean = false;

  /**
   * Creates an instance of PullNetworkProviderStrategy.
   * @param log - The application logger.
   * @param networkProvider - The network provider service.
   * @param queue - The blocks queue.
   * @param config - Configuration object containing maxRequestBlocksBatchSize.
   */
  constructor(
    private readonly log: AppLogger,
    private readonly networkProvider: NetworkProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRequestBlocksBatchSize: number;
      concurrency: number;
      isTest: boolean;
    }
  ) {
    this._maxRequestBlocksBatchSize = config.maxRequestBlocksBatchSize;
    this._concurrency = config.concurrency;
    this.isTest = config.isTest;
  }

  /**
   * Loads blocks up to the current network height.
   * @param currentNetworkHeight - The current height of the network.
   * @throws Will throw an error if the maximum block height or current network height is reached,
   *         or if the queue is full.
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    if (this.queue.isMaxHeightReached) {
      this.log.debug('Reached max block height', { queueLastHeight: this.queue.lastHeight }, this.constructor.name);
      return;
    }

    // Check if we have reached the current network height
    if (this.queue.lastHeight >= currentNetworkHeight) {
      this.log.debug(
        'Reached current network height',
        { queueLastHeight: this.queue.lastHeight },
        this.constructor.name
      );
      return;
    }

    // Check if the queue is full
    if (this.queue.isQueueFull) {
      this.log.debug('The queue is full', { queueLastHeight: this.queue.lastHeight }, this.constructor.name);
      return;
    }

    // We only upload new hashes if we've already used them all.
    if (this._preloadedItemsQueue.length === 0) {
      // console.time('preloadblocks');
      await this.preloadBlocksInfo(currentNetworkHeight);
      // console.timeEnd('preloadblocks')
    }

    // IMPORTANT: This check is mandatory after preload.
    // We don't want to start downloading blocks if there is no items in the queue for them
    if (this.queue.isQueueOverloaded(this._maxRequestBlocksBatchSize * this._concurrency)) {
      this.log.debug('The queue is overloaded', {}, this.constructor.name);
      return;
    }

    if (this._preloadedItemsQueue.length > 0) {
      // console.time('fetchblocks')
      await this.loadAndEnqueueBlocks();
      // console.timeEnd('fetchblocks')
    }
  }

  /**
   * Stops the loading process by clearing the _preloadedItemsQueue.
   */
  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];
  }

  @RuntimeTracker({ showMemory: false, warningThresholdMs: 800, errorThresholdMs: 10000 })
  private async preloadBlocksInfo(currentNetworkHeight: number): Promise<void> {
    let lastHeight: number = this.queue.lastHeight;
    let lastCount: number = 0;
    const maxCount = this.isTest ? 1 : 10000;

    // Load as many blocks as possible until reaching the size limit or the current network height
    while (lastCount <= maxCount && lastHeight < currentNetworkHeight) {
      const heights: number[] = [];
      // Keep it here; we don't want to fetch more than 100 at a time
      // IMPORTANT: We keep this value small so as not to request many repeated blocks,
      // since anything higher in volume will simply be discarded.
      const batchSize = this.isTest ? 1 : 100;

      for (let i = 0; i < batchSize; i++) {
        const nextHeight = lastHeight + 1 + i;
        if (nextHeight > currentNetworkHeight) break;
        heights.push(nextHeight);
      }

      const blocksStats = await this.networkProvider.getManyBlocksStatsByHeights(heights);

      for (const { blockhash, total_size, height } of blocksStats) {
        if (
          blockhash === undefined ||
          blockhash === null ||
          total_size === undefined ||
          total_size === null ||
          height === undefined ||
          height === null
        ) {
          throw new Error('Block stats params is missed');
        }

        this._preloadedItemsQueue.push({ hash: blockhash, size: total_size, height });
        lastHeight = height;
        lastCount += 1;
      }
    }
  }

  @RuntimeTracker({ showMemory: false, warningThresholdMs: 800, errorThresholdMs: 10000 })
  private async loadAndEnqueueBlocks(): Promise<void> {
    // Number of retries
    const retryLimit = 3;

    const activeTasks: Promise<Block[]>[] = [];

    this._preloadedItemsQueue.sort((a, b) => {
      if (a.height < b.height) return 1;
      if (a.height > b.height) return -1;
      return 0;
    });

    for (let i = 0; i < this._concurrency; i++) {
      const hashes: string[] = [];
      let size = 0;

      while (size < this._maxRequestBlocksBatchSize && this._preloadedItemsQueue.length > 0) {
        const item = this._preloadedItemsQueue.pop();
        if (!item) {
          break;
        }

        hashes.push(item.hash);
        size += item.size;
      }

      activeTasks.push(this.loadBlocks(hashes, retryLimit));
    }

    const batches: Block[][] = await Promise.all(activeTasks);
    const blocks: Block[] = batches.flat();

    await this.enqueueBlocks(blocks);
  }

  /**
   * Fetches blocks in batches with retry logic.
   * @param batch - Array of block hashes.
   * @param maxRetries - Maximum number of retry attempts.
   * @returns Array of fetched blocks.
   * @throws Will throw an error if fetching blocks fails after maximum retries.
   */
  private async loadBlocks(hashBatch: string[], maxRetries: number): Promise<Block[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const blocks: Block[] = await this.networkProvider.getManyBlocksByHashes(hashBatch, 2); // verbosity=2
        return blocks;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.log.warn(
            'Exceeded max retries for fetching blocks batch.',
            { batchLength: hashBatch.length },
            this.constructor.name
          );
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Failed to fetch blocks batch after maximum retries.');
  }

  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    blocks.sort((a, b) => {
      if (a.height < b.height) return 1;
      if (a.height > b.height) return -1;
      return 0;
    });

    while (blocks.length > 0) {
      const block = blocks.pop();

      if (block) {
        if (block.height <= this.queue.lastHeight) {
          // The situation is when somehow we still have old blocks, we just skip them
          this.log.debug('Skipping block with height less than or equal to lastHeight', {
            blockHeight: block.height,
            lastHeight: this.queue.lastHeight,
          });

          continue;
        }

        // In case of errors we should throw all this away without try catch
        // to reset everything and try again
        await this.queue.enqueue(block);
      }
    }
  }
}
