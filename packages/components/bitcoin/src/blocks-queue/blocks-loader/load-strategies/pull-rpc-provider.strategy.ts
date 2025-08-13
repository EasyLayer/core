import { BlockchainProviderService, Block } from '../../../blockchain-provider';
import { AppLogger, RuntimeTracker } from '@easylayer/common/logger';
import { BlocksLoadingStrategy, StrategyNames } from './load-strategy.interface';
import { BlocksQueue } from '../../blocks-queue';

interface BlockInfo {
  hash: string;
  size: number;
  height: number;
}

export class PullRpcProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.RPC_PULL;
  private _maxRequestBlocksBatchSize: number = 10 * 1024 * 1024; // Batch size in bytes
  private _preloadedItemsQueue: BlockInfo[] = [];

  private _maxPreloadCount: number;
  private _lastLoadAndEnqueueDuration = 0;
  private _previousLoadAndEnqueueDuration = 0;

  /**
   * Creates an instance of PullNetworkProviderStrategy.
   * @param log - The application logger.
   * @param blockchainProvider - The blockchain provider service.
   * @param queue - The blocks queue.
   * @param config - Configuration object containing maxRequestBlocksBatchSize.
   */
  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRequestBlocksBatchSize: number;
      basePreloadCount: number;
    }
  ) {
    this._maxRequestBlocksBatchSize = config.maxRequestBlocksBatchSize;
    this._maxPreloadCount = config.basePreloadCount;
  }

  /**
   * Loads blocks up to the current network height.
   * @param currentNetworkHeight - The current height of the network.
   * @throws Will throw an error if the maximum block height or current network height is reached,
   *         or if the queue is full.
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    if (this.queue.isMaxHeightReached) {
      throw new Error('Reached max block height');
    }

    // Check if we have reached the current network height
    if (this.queue.lastHeight >= currentNetworkHeight) {
      // IMPORTANT: we return as successfull without an error
      return;
      // throw new Error('Reached current network height');
    }

    // Check if the queue is full
    if (this.queue.isQueueFull) {
      throw new Error('The queue is full');
    }

    // We only upload new hashes if we've already used them all.
    if (this._preloadedItemsQueue.length === 0) {
      await this.preloadBlocksInfo(currentNetworkHeight);
    }

    // IMPORTANT: This check is mandatory after preload.
    // We don't want to start downloading blocks if there is no items in the queue for them
    if (this.queue.isQueueOverloaded(this._maxRequestBlocksBatchSize * 1)) {
      this.log.debug('The queue is overloaded');
      return;
    }

    if (this._preloadedItemsQueue.length > 0) {
      await this.loadAndEnqueueBlocks();
    }
  }

  /**
   * Stops the loading process by clearing the _preloadedItemsQueue.
   */
  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];
  }

  /**
   * Preloads block metadata (hash, size, height) into the internal queue in a single RPC call,
   * and dynamically tunes the preload batch size based on previous loadAndEnqueue timing.
   *
   * Behavior:
   * 1. If this is not the first preload invocation, compare current vs previous loadAndEnqueue timing:
   *    - If `timingRatio > 1.2` (current took 20%+ longer), increase `_maxPreloadCount` by 25%
   *    - If `timingRatio < 0.8` (current took 20%+ less time), decrease `_maxPreloadCount` by 25%, but not below 1
   *    - If timing is similar (0.8-1.2 range), leave `_maxPreloadCount` unchanged
   * 2. Calculate how many blocks remain between `queue.lastHeight` and
   *    `currentNetworkHeight`, and cap the request count to `_maxPreloadCount`.
   * 3. If the resulting `count` is zero or negative, return immediately.
   * 4. Request stats for heights `[lastHeight+1 ... lastHeight+count]` via
   *    `blockchainProvider.getManyBlocksStatsByHeights`.
   * 5. For each returned stat:
   *    - Throw if `blockhash` or `height` is missing.
   *    - Use `total_size` if present, otherwise fall back to `queue.blockSize`.
   *    - Push `{ hash, size, height }` into `_preloadedItemsQueue`.
   *
   * @param currentNetworkHeight - The latest block height as reported by the network.
   * @throws {Error} If any returned block stat is missing a hash or height.
   * @returns A promise that resolves once all stats have been enqueued.
   */
  @RuntimeTracker({ warningThresholdMs: 1000, errorThresholdMs: 8000 })
  private async preloadBlocksInfo(currentNetworkHeight: number): Promise<void> {
    // Dynamic adjustment based on timing comparison with previous loadAndEnqueue
    if (this._previousLoadAndEnqueueDuration > 0 && this._lastLoadAndEnqueueDuration > 0) {
      const timingRatio = this._lastLoadAndEnqueueDuration / this._previousLoadAndEnqueueDuration;

      if (timingRatio > 1.2) {
        // Current loadAndEnqueue took significantly longer - need more preload buffer
        this._maxPreloadCount = Math.round(this._maxPreloadCount * 1.25);
      } else if (timingRatio < 0.8) {
        // Current loadAndEnqueue was significantly faster - can reduce preload buffer
        this._maxPreloadCount = Math.max(1, Math.round(this._maxPreloadCount * 0.75));
      }
    }

    const lastHeight = this.queue.lastHeight;
    const remaining = currentNetworkHeight - lastHeight;
    const count = Math.min(this._maxPreloadCount, remaining);
    if (count <= 0) {
      return;
    }

    const heights = Array.from({ length: count }, (_, i) => lastHeight + 1 + i);

    // Use the new optimized method for getting block info
    const blockInfos = await this.blockchainProvider.getManyBlocksStatsByHeights(heights);

    // Fill the preload queue, substituting the default size if there is none
    for (const { blockhash, total_size, height } of blockInfos) {
      if (!blockhash || height == null) {
        throw new Error('Block infos missing required hash and height');
      }
      const size = total_size != null ? total_size : this.queue.blockSize;
      this._preloadedItemsQueue.push({ hash: blockhash, size, height });
    }
  }

  /**
   * Load blocks metadata in parallel batches, parse them into Block instances and enqueue.
   *
   * - Sorts pending block infos by height (highest first).
   * - Splits into up to `_concurrency` batches, each limited by `_maxRequestBlocksBatchSize`.
   * - For each batch:
   *   1. Calls `loadBlocks(infos, retryLimit)` to fetch raw hex via RPC (`verbosity=0`) with retries.
   *   2. Parses each raw hex into a `Block` using `bitcoinjs-lib` and `ScriptUtilService`.
   * - Flattens all loaded blocks and calls `enqueueBlocks(blocks)`.
   *
   * @returns A promise that resolves once all blocks are enqueued.
   * @internal
   */
  private async loadAndEnqueueBlocks(): Promise<void> {
    const retryLimit = 3;
    const startTime = Date.now();

    const activeTasks: Promise<Block[]>[] = [];
    let totalInfosPulled = 0;

    this._preloadedItemsQueue.sort((a, b) => {
      if (a.height < b.height) return 1;
      if (a.height > b.height) return -1;
      return 0;
    });

    for (let i = 0; i < 1; i++) {
      // 1 - conccurency
      const infos: BlockInfo[] = [];
      let size = 0;

      while (size < this._maxRequestBlocksBatchSize && this._preloadedItemsQueue.length > 0) {
        const info = this._preloadedItemsQueue.pop()!;

        if (size + info.size <= this._maxRequestBlocksBatchSize) {
          infos.push(info);
          size += info.size;
        } else {
          // If it doesn't fit, we return it back to the queue.
          this._preloadedItemsQueue.push(info);
          break;
        }
      }

      if (infos.length > 0) {
        totalInfosPulled += infos.length;
        activeTasks.push(this.loadBlocks(infos, retryLimit));
      }
    }

    const batches: Block[][] = await Promise.all(activeTasks);
    const blocks: Block[] = batches.flat();
    await this.enqueueBlocks(blocks);

    // Update timing history
    this._previousLoadAndEnqueueDuration = this._lastLoadAndEnqueueDuration;
    this._lastLoadAndEnqueueDuration = Date.now() - startTime;
  }

  /**
   * Fetches blocks in batches with retry logic.
   * @param infos - Array of block infos.
   * @param maxRetries - Maximum number of retry attempts.
   * @returns Array of fetched blocks.
   * @throws Will throw an error if fetching blocks fails after maximum retries.
   */
  @RuntimeTracker({ warningThresholdMs: 3000, errorThresholdMs: 10000 })
  private async loadBlocks(infos: BlockInfo[], maxRetries: number): Promise<Block[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const heights = infos.map((i) => i.height);
        // Use the new performance method that returns fully parsed blocks with all transactions
        const blocks: Block[] = await this.blockchainProvider.getManyBlocksByHeights(
          heights,
          true, // useHex = true for better performance and complete transaction data
          undefined, // verbosity ignored when useHex = true
          true // verifyMerkle = true for security
        );
        return blocks;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.log.debug('Exceeded max retries for fetching blocks batch.', {
            methodName: 'loadBlocks',
            args: { batchLength: infos.length },
          });
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
            args: {
              blockHeight: block.height,
              lastHeight: this.queue.lastHeight,
            },
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
