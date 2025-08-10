import { AppLogger, RuntimeTracker } from '@easylayer/common/logger';
import { BlockchainProviderService } from '../../../blockchain-provider';
import type { Block } from '../../../blockchain-provider';
import { BlocksLoadingStrategy, StrategyNames } from './load-strategy.interface';
import { BlocksQueue } from '../../blocks-queue';

export class PullRpcProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.RPC_PULL;
  private _maxRequestBlocksBatchSize: number = 10 * 1024 * 1024; // Batch size in bytes
  private _preloadedItemsQueue: Block[] = []; // Blocks + Transactions - Receipts

  private _maxPreloadCount: number;
  private _lastLoadReceiptsDuration = 0;
  private _previousLoadReceiptsDuration = 0;

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

    // Only preload blocks with transactions if array is empty
    if (this._preloadedItemsQueue.length === 0) {
      await this.preloadBlocksWithTransactions(currentNetworkHeight);
    }

    // IMPORTANT: This check is mandatory after preload.
    // We don't want to start downloading receipts if there is no space in the queue
    if (this.queue.isQueueOverloaded(this._maxRequestBlocksBatchSize * 1)) {
      this.log.debug('The queue is overloaded');
      return;
    }

    if (this._preloadedItemsQueue.length > 0) {
      await this.loadReceiptsAndEnqueueBlocks();
    }
  }

  /**
   * Stops the loading process by clearing the preloaded items queue.
   */
  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];
  }

  /**
   * Phase 1: Preloads blocks with transactions and stores them locally.
   *
   * This method implements dynamic adjustment of the preload count based on loadReceipts timing:
   * - If `timingRatio > 1.2` (current took 20%+ longer), increase `_maxPreloadCount` by 25%
   * - If `timingRatio < 0.8` (current took 20%+ less time), decrease `_maxPreloadCount` by 25%, but not below 1
   * - If timing is similar (0.8-1.2 range), leave `_maxPreloadCount` unchanged
   *
   * The method loads blocks with full transactions but without receipts to optimize
   * memory usage and network traffic for the initial phase.
   *
   * @param currentNetworkHeight - The latest block height as reported by the network
   * @throws {Error} If the blockchain provider fails to fetch blocks
   * @returns A promise that resolves once all blocks with transactions are preloaded
   */
  @RuntimeTracker({ warningThresholdMs: 1000, errorThresholdMs: 8000 })
  private async preloadBlocksWithTransactions(currentNetworkHeight: number): Promise<void> {
    // Dynamic adjustment based on timing comparison with previous loadReceipts
    if (this._previousLoadReceiptsDuration > 0 && this._lastLoadReceiptsDuration > 0) {
      const timingRatio = this._lastLoadReceiptsDuration / this._previousLoadReceiptsDuration;

      if (timingRatio > 1.2) {
        // Current loadReceipts took significantly longer - need more preload buffer
        this._maxPreloadCount = Math.round(this._maxPreloadCount * 1.25);
      } else if (timingRatio < 0.8) {
        // Current loadReceipts was significantly faster - can reduce preload buffer
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
    this._preloadedItemsQueue = await this.blockchainProvider.getManyBlocksByHeights(heights, true, true); // true = with transactions
  }

  /**
   * Phase 2: Loads receipts for preloaded blocks and enqueues complete blocks.
   *
   * This method processes the blocks loaded in Phase 1 by:
   * 1. Creating optimal batches based on estimated receipt sizes
   * 2. Loading receipts concurrently for each batch
   * 3. Combining receipts with existing block data
   * 4. Normalizing and enqueuing the complete blocks
   *
   * The batching algorithm uses heuristics to estimate receipt sizes based on
   * transaction count and block size to optimize network requests.
   *
   * @throws {Error} If receipt loading fails after maximum retries
   * @returns A promise that resolves once all blocks are processed and enqueued
   */
  private async loadReceiptsAndEnqueueBlocks(): Promise<void> {
    const retryLimit = 3;
    const startTime = Date.now();

    // Create batches for receipts loading based on transaction count and estimated receipt sizes
    const receiptsBatches = this.createOptimalBatchesForReceipts();

    const activeTasks: Promise<Block[]>[] = [];

    for (let i = 0; i < 1; i++) {
      // 1 - _concurrency
      const batch = receiptsBatches[i];
      if (batch) {
        activeTasks.push(this.loadBlocks(batch.blocks, retryLimit));
      }
    }

    const results: Block[][] = await Promise.all(activeTasks);
    const completeBlocks: Block[] = results.flat();

    // Clear processed blocks
    this._preloadedItemsQueue = [];

    // Enqueue complete blocks
    await this.enqueueBlocks(completeBlocks);

    // Update timing history
    this._previousLoadReceiptsDuration = this._lastLoadReceiptsDuration;
    this._lastLoadReceiptsDuration = Date.now() - startTime;
  }

  /**
   * Creates optimal batches for receipt loading based on estimated sizes.
   *
   * This method analyzes the preloaded blocks and groups them into batches
   * that respect the maximum batch size limit. The algorithm:
   * 1. Sorts blocks by block number (descending)
   * 2. Estimates receipt size for each block using heuristics
   * 3. Groups blocks into batches that don't exceed the size limit
   * 4. Ensures each batch has at least one block
   *
   * The estimation heuristics consider transaction count and block size:
   * - Large blocks (> 2MB): ~2KB per receipt
   * - Medium blocks (> 500KB): ~1KB per receipt
   * - Small blocks (< 500KB): ~500B per receipt
   *
   * @returns Array of batch objects containing blocks and estimated sizes
   */
  private createOptimalBatchesForReceipts(): { blocks: Block[]; maxPossibleSize: number }[] {
    const batches: { blocks: Block[]; maxPossibleSize: number }[] = [];
    this._preloadedItemsQueue.sort((a, b) => {
      if (a.blockNumber < b.blockNumber) return -1;
      if (a.blockNumber > b.blockNumber) return 1;
      return 0;
    });

    let currentBatch: Block[] = [];
    let currentEstimatedReceiptsSize = 0;

    for (const block of this._preloadedItemsQueue) {
      // Estimate receipts size for this block
      const estimatedReceiptsSize = this.estimateReceiptsSize(block);

      // Check if receipts fit in current batch
      if (
        currentEstimatedReceiptsSize + estimatedReceiptsSize <= this._maxRequestBlocksBatchSize ||
        currentBatch.length === 0
      ) {
        currentBatch.push(block);
        currentEstimatedReceiptsSize += estimatedReceiptsSize;
      } else {
        // Finish current batch and start new one
        batches.push({
          blocks: [...currentBatch],
          maxPossibleSize: currentEstimatedReceiptsSize,
        });

        currentBatch = [block];
        currentEstimatedReceiptsSize = estimatedReceiptsSize;
      }
    }

    // Add final batch if not empty
    if (currentBatch.length > 0) {
      batches.push({
        blocks: currentBatch,
        maxPossibleSize: currentEstimatedReceiptsSize,
      });
    }

    return batches;
  }

  /**
   * Estimates the size of receipts for a given block using heuristic analysis.
   *
   * The estimation algorithm considers:
   * - Number of transactions in the block
   * - Block size without receipts as an indicator of transaction complexity
   * - Different receipt size multipliers based on block characteristics
   *
   * Size categories and estimates:
   * - Large blocks (> 2MB): Complex transactions with many logs → 2KB per receipt
   * - Medium blocks (> 500KB): Moderate complexity → 1KB per receipt
   * - Small blocks (< 500KB): Simple transactions → 500B per receipt
   *
   * @param block - The block to estimate receipt size for
   * @returns Estimated total size of receipts in bytes, or 0 if no transactions
   */
  private estimateReceiptsSize(block: Block): number {
    if (!block.transactions || block.transactions.length === 0) {
      return 0;
    }

    const txCount = block.transactions.length;
    const blockSizeWithoutReceipts = block.sizeWithoutReceipts || 0;

    // Use heuristics based on block size and transaction count
    if (blockSizeWithoutReceipts > 2 * 1024 * 1024) {
      // > 2MB
      // Large blocks likely have complex transactions with many logs
      return txCount * 2000; // ~2KB per receipt on average
    } else if (blockSizeWithoutReceipts > 500 * 1024) {
      // > 500KB
      // Medium blocks with moderate complexity
      return txCount * 1000; // ~1KB per receipt on average
    } else {
      // Small blocks with simple transactions
      return txCount * 500; // ~500B per receipt on average
    }
  }

  /**
   * Loads receipts for a batch of blocks and combines them efficiently.
   *
   * This method implements optimized receipt loading:
   * 1. Extracts transaction hashes from all blocks in the batch
   * 2. Loads all receipts in a single batch request to minimize network overhead
   * 3. Uses provider service to merge receipts with blocks and recalculate sizes
   *
   * @param blocks - Array of blocks to load receipts for
   * @param maxRetries - Maximum number of retry attempts for failed requests
   * @throws {Error} If receipt loading fails after all retry attempts
   * @returns Promise resolving to array of blocks with receipts attached
   */
  @RuntimeTracker({ warningThresholdMs: 3000, errorThresholdMs: 10000 })
  private async loadBlocks(blocks: Block[], maxRetries: number): Promise<Block[]> {
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Extract block heights from all blocks in batch
        const blockHeights: number[] = blocks.map((block: Block) => block.blockNumber);

        // Get all block receipts at once using eth_getBlockReceipts
        const allBlocksReceipts = await this.blockchainProvider.getManyBlocksWithReceipts(
          blockHeights,
          undefined,
          true
        );
        return allBlocksReceipts;
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.log.error('Exceeded max retries for receipts batch', {
            args: { blockCount: blocks.length, error },
          });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }

    throw new Error('Failed to fetch receipts batch after maximum retries.');
  }

  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    blocks.sort((a, b) => {
      if (a.blockNumber < b.blockNumber) return 1;
      if (a.blockNumber > b.blockNumber) return -1;
      return 0;
    });

    while (blocks.length > 0) {
      const block = blocks.pop();

      if (block) {
        if (block.blockNumber <= this.queue.lastHeight) {
          // The situation is when somehow we still have old blocks, we just skip them
          this.log.debug('Skipping block with height less than or equal to lastHeight', {
            args: {
              blockHeight: block.blockNumber,
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
