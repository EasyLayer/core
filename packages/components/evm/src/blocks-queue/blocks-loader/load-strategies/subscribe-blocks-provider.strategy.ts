import type { AppLogger } from '@easylayer/common/logger';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from '../load-strategies';
import type { BlocksQueue } from '../../blocks-queue';

/**
 * Subscription-based blocks loading strategy that sets up WebSocket subscription to new blocks.
 *
 * This strategy performs initial catch-up to sync with the current network height before
 * establishing the subscription to ensure no blocks are missed during the setup phase.
 *
 * The strategy:
 * 1. Performs initial catch-up from queue.lastHeight to currentNetworkHeight
 * 2. Sets up WebSocket subscription for new incoming blocks
 * 3. Filters and enqueues blocks based on queue state and termination conditions
 *
 * @example
 * ```typescript
 * const strategy = new SubscribeBlocksProviderStrategy(
 *   logger,
 *   blockchainProvider,
 *   queue,
 *   config
 * );
 *
 * await strategy.load(12345); // Catch up to height 12345 then subscribe
 * ```
 */
export class SubscribeBlocksProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.SUBSCRIBE;

  // Hold the active subscription (Promise<void> & { unsubscribe(): void }) or undefined
  private _subscription?: Promise<void> & { unsubscribe: () => void };

  constructor(
    private readonly log: AppLogger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: any
  ) {
    // No special config needed here
  }

  /**
   * Starts the blocks loading process with initial catch-up and subscription setup.
   *
   * This method:
   * 1. Performs initial catch-up to sync with current network height
   * 2. Sets up WebSocket subscription to new blocks
   * 3. Handles incoming blocks with termination condition checks
   * 4. Automatically cleans up resources on completion or error
   *
   * @param currentNetworkHeight - The current network block height to catch up to
   * @throws {Error} When subscription fails, queue is full, max height reached, or current network height reached
   * @returns {Promise<void>} Resolves when subscription completes normally or meets completion conditions
   */
  async load(currentNetworkHeight: number): Promise<void> {
    if (this._subscription) {
      this.log.debug(`Already subscribed to new blocks`);
      return;
    }

    try {
      // First perform catch-up to current network height
      await this.performInitialCatchup(currentNetworkHeight);

      // Call subscribeToNewBlocks(…) and store its return-value (the promise object, which has `unsubscribe()`)
      this._subscription = this.blockchainProvider.subscribeToNewBlocks(async (block) => {
        if (this.queue.isMaxHeightReached) {
          throw new Error('Reached max block height');
        }

        // Check if we have reached the current network height
        if (this.queue.lastHeight >= currentNetworkHeight) {
          throw new Error('Reached current network height');
        }

        // Check if the queue is full
        if (this.queue.isQueueFull) {
          throw new Error('The queue is full');
        }

        // Enqueue the new block
        await this.enqueueBlock(block);
      });

      this.log.debug(`Subscription created, waiting for new blocks`);

      // Wait for the subscription to complete (will hang until unsubscribed, error, or termination condition)
      await this._subscription;

      this.log.debug(`Subscription completed successfully`);
    } finally {
      // Always clean up subscription resources
      if (this._subscription) {
        try {
          // Attempt to unsubscribe if the subscription object has unsubscribe method
          if (typeof this._subscription.unsubscribe === 'function') {
            this._subscription.unsubscribe();
            this.log.debug(`Successfully unsubscribed from block subscription`);
          }
        } catch (unsubscribeError) {
          // Log but don't throw - we don't want cleanup errors to mask original errors
          this.log.debug(`Failed to unsubscribe from block subscription`, {
            args: { error: unsubscribeError },
            methodName: 'load',
          });
        }
      }

      // Clear the subscription reference so future load() calls can create new subscriptions
      this._subscription = undefined;

      this.log.debug(`Load method cleanup completed`);
    }
  }

  /**
   * Cancels the existing subscription and stops the loading process.
   *
   * This method safely unsubscribes from the WebSocket connection and cleans up
   * internal state. It can be called multiple times safely.
   *
   * @returns {Promise<void>} Resolves when cleanup is complete
   */
  public async stop(): Promise<void> {
    if (!this._subscription) {
      this.log.debug('No active subscription to stop');
      return;
    }

    try {
      this._subscription.unsubscribe();
      this.log.debug('Unsubscribed from new blocks');
    } catch (error) {
      this.log.error('Error while unsubscribing', {
        args: { error },
        methodName: 'stop',
      });
    } finally {
      this._subscription = undefined;
    }
  }

  /**
   * Performs initial catch-up to synchronize queue with current network height.
   *
   * This method fetches and enqueues all blocks from (queue.lastHeight + 1) to targetHeight
   * using batch request to optimize network calls. All blocks are fetched with full transactions.
   *
   * @param targetHeight - The target height to catch up to (usually current network height)
   * @throws {Error} When the gap is too large (>100 blocks)
   * @returns {Promise<void>} Resolves when all missing blocks are fetched and enqueued
   */
  private async performInitialCatchup(targetHeight: number): Promise<void> {
    const queueHeight = this.queue.lastHeight;

    if (queueHeight >= targetHeight) {
      this.log.debug('No initial catch-up needed', {
        args: { queueHeight, targetHeight },
      });
      return;
    }

    const blocksToFetch = targetHeight - queueHeight;
    const maxAllowedGap = 100; // Maximum blocks to fetch in one batch

    if (blocksToFetch > maxAllowedGap) {
      const errorMessage =
        `Gap too large for subscription strategy: ${blocksToFetch} blocks (max allowed: ${maxAllowedGap}). ` +
        `Consider using a different loading strategy or reducing the gap. ` +
        `Queue height: ${queueHeight}, Target height: ${targetHeight}`;

      this.log.error('Initial catch-up gap too large', {
        args: {
          queueHeight,
          targetHeight,
          blocksToFetch,
          maxAllowedGap,
          suggestion: 'Use sequential or parallel loading strategy instead',
        },
      });

      throw new Error(errorMessage);
    }

    this.log.info('Performing initial catch-up', {
      args: {
        from: queueHeight + 1,
        to: targetHeight,
        blocksCount: blocksToFetch,
      },
    });

    const heights: number[] = [];

    // Generate array of heights to fetch
    for (let height = queueHeight + 1; height <= targetHeight; height++) {
      heights.push(height);
    }

    // Fetch all blocks in a single batch request with full transactions
    const blocks = await this.blockchainProvider.getManyBlocksByHeights(heights, true);

    // Enqueue blocks in correct order
    await this.enqueueBlocks(blocks);

    this.log.debug('Initial catch-up completed successfully', {
      args: { blocksProcessed: blocks.length },
    });
  }

  private async enqueueBlock(block: Block): Promise<void> {
    if (block.blockNumber <= this.queue.lastHeight) {
      // The situation is when somehow we still have old blocks, we just skip them
      this.log.debug('Skipping block with height less than or equal to lastHeight', {
        args: {
          blockHeight: block.blockNumber,
          lastHeight: this.queue.lastHeight,
        },
      });

      return;
    }

    // In case of errors we should throw all this away without try catch
    // to reset everything and try again
    await this.queue.enqueue(block);
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
        await this.enqueueBlock(block);
      }
    }
  }
}
