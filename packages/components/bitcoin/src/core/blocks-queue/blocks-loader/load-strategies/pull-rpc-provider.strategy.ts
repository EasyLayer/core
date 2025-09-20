import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

interface BlockInfo {
  hash: string;
  size: number; // binary total_size
  height: number;
}

/**
 * Pull RPC Provider Strategy with reply-size budgeting.
 * We treat the limit as "RPC reply budget" (bytes), not sum of binary block sizes.
 * Approximate reply size = sum(total_size) * 2.1 (×2 hex + ~10% JSON overhead).
 */
export class PullRpcProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.RPC_PULL;

  // Budget of expected RPC reply bytes (not raw block bytes)
  private _maxRpcReplyBytes: number = 10 * 1024 * 1024;
  private _preloadedItemsQueue: BlockInfo[] = [];

  private _maxPreloadCount: number;
  private _lastLoadAndEnqueueDuration = 0;
  private _previousLoadAndEnqueueDuration = 0;

  /**
   * Creates an instance of PullNetworkProviderStrategy.
   * @param log - The application logger.
   * @param blockchainProvider - The blockchain provider service.
   * @param queue - The blocks queue.
   * @param config - Configuration object.
   *
   */
  constructor(
    private readonly log: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRpcReplyBytes: number;
      basePreloadCount: number;
    }
  ) {
    this._maxRpcReplyBytes = config.maxRpcReplyBytes;
    this._maxPreloadCount = config.basePreloadCount;
  }

  /**
   * Loads blocks up to the current network height in a continuous loop.
   * @param currentNetworkHeight - The current height of the network.
   * @throws Will throw an error if the maximum block height is reached.
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    while (this.queue.lastHeight < currentNetworkHeight) {
      if (this.queue.isMaxHeightReached) {
        return;
      }

      // Check if the queue is full
      if (this.queue.isQueueFull) {
        // IMPORTANT: the error throw triggers a timer refresh
        throw new Error('The queue is full, waiting before retry');
      }

      // We only upload new hashes if we've already used them all.
      if (this._preloadedItemsQueue.length === 0) {
        await this.preloadBlocksInfo(currentNetworkHeight);
      }

      // IMPORTANT: This check is mandatory after preload.
      // We don't want to start downloading blocks if there is no items in the queue for them
      if (this.queue.isQueueOverloaded(this._maxRpcReplyBytes)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (this._preloadedItemsQueue.length > 0) {
        await this.loadAndEnqueueBlocks();
      }

      // Wait 1 second between iterations to avoid overwhelming the system
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
   * Load blocks metadata in a single batch, parse them into Block instances and enqueue.
   *
   * Batching logic:
   * - Sort pending block infos by height (highest first).
   * - Fill one batch limited by the **reply budget**:
   *     predictedReplyBytes ≈ sum(total_size) * 2.1
   * - Fetch via hex RPC (verbosity=0), provider parses from bytes, not hex strings.
   * - After enqueue, aggressively release big arrays to help GC.
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
      let predictedReplyBytes = 0;
      const OVERHEAD = 2.1; // ×2 hex + ~10% JSON envelope

      // Fill the batch by reply-size budget
      while (this._preloadedItemsQueue.length > 0) {
        const next = this._preloadedItemsQueue[this._preloadedItemsQueue.length - 1]!;
        const nextPredicted = predictedReplyBytes + Math.floor(next.size * OVERHEAD);
        if (nextPredicted > this._maxRpcReplyBytes) break;

        const info = this._preloadedItemsQueue.pop()!;
        infos.push(info);
        predictedReplyBytes = nextPredicted;
      }

      if (infos.length > 0) {
        totalInfosPulled += infos.length;
        activeTasks.push(this.loadBlocks(infos, retryLimit));
      }
    }

    const batches: Block[][] = await Promise.all(activeTasks);
    const blocks: Block[] = batches.flat();

    await this.enqueueBlocks(blocks);

    // Release large arrays ASAP to help GC
    blocks.length = 0;
    batches.length = 0;

    // Update timing history
    this._previousLoadAndEnqueueDuration = this._lastLoadAndEnqueueDuration;
    this._lastLoadAndEnqueueDuration = Date.now() - startTime;
  }

  /**
   * Fetches blocks in batches with retry logic.
   * @param infos - Array of block infos.
   * @param maxRetries - Maximum number of retry attempts.
   */
  private async loadBlocks(infos: BlockInfo[], maxRetries: number): Promise<Block[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const heights = infos.map((i) => i.height);
        // Provider parses from bytes; use useHex=true for performance and complete transaction data
        const blocks: Block[] = await this.blockchainProvider.getManyBlocksByHeights(
          heights,
          true, // useHex = true (bytes path under the hood)
          undefined, // verbosity ignored when useHex = true
          true // verifyMerkle = true for security
        );
        return blocks;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.log.verbose('Exceeded max retries for fetching blocks batch.', {
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
      if (!block) continue;

      if (block.height <= this.queue.lastHeight) {
        // Skip old blocks quietly
        this.log.verbose('Skipping block with height less than or equal to lastHeight', {
          args: { blockHeight: block.height, lastHeight: this.queue.lastHeight },
        });
        continue;
      }

      // No try/catch here by design to reset on errors
      await this.queue.enqueue(block);
    }
  }
}
