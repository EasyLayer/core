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
   * 4. Returns a Promise that resolves only when stopped or rejects on errors
   *
   * @param currentNetworkHeight - The current network block height to catch up to
   * @throws {Error} When subscription fails, queue is full, or critical errors occur
   * @returns {Promise<void>} Resolves when subscription is stopped, rejects on errors for restart
   */
  async load(currentNetworkHeight: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._subscription) {
        this.log.debug('Already subscribed to new blocks');
        resolve();
        return;
      }

      // Use async IIFE to handle async operations inside Promise
      (async () => {
        try {
          // First perform catch-up to current network height
          await this.performInitialCatchup(currentNetworkHeight);

          // Create subscription to new blocks
          this._subscription = this.blockchainProvider.subscribeToNewBlocks(async (block) => {
            try {
              if (this.queue.isMaxHeightReached) {
                this._subscription?.unsubscribe();
                reject(new Error('Reached max block height'));
                return;
              }

              // IMPORTANT: we don't need to check currentNetworkHeight here
              // because we subscribe on new blocks

              // Check if the queue is full
              if (this.queue.isQueueFull) {
                this._subscription?.unsubscribe();
                reject(new Error('The queue is full'));
                return;
              }

              // Enqueue the new block
              await this.enqueueBlock(block);
            } catch (error) {
              this._subscription?.unsubscribe();
              reject(error);
            }
          });

          this.log.debug('Subscription created, waiting for new blocks');

          // Wait for the subscription to complete (will hang until unsubscribed, error, or termination condition)
          await this._subscription;

          this.log.debug('Subscription completed successfully');
          resolve();
        } catch (setupError) {
          reject(setupError);
        } finally {
          // Always clean up subscription resources
          this.cleanup();
        }
      })();
    });
  }

  /**
   * Stops the subscription and cleans up resources.
   * This will cause the load() Promise to resolve.
   *
   * @returns {Promise<void>} Resolves when cleanup is complete
   */
  public async stop(): Promise<void> {
    this.log.debug('Stopping subscription strategy');

    if (!this._subscription) {
      this.log.debug('No active subscription to stop');
      return;
    }

    try {
      this._subscription.unsubscribe();
      this.log.debug('Unsubscribed from new blocks');
    } catch (error) {
      this.log.debug('Error while unsubscribing', {
        args: { error },
        methodName: 'stop',
      });
    } finally {
      this._subscription = undefined;
    }
  }

  /**
   * Cleans up subscription resources and resets state.
   *
   * @private
   */
  private cleanup(): void {
    if (this._subscription) {
      try {
        if (typeof this._subscription.unsubscribe === 'function') {
          this._subscription.unsubscribe();
          this.log.debug('Successfully unsubscribed from block subscription');
        }
      } catch (unsubscribeError) {
        this.log.debug('Failed to unsubscribe from block subscription', {
          args: { error: unsubscribeError },
          methodName: '_cleanup',
        });
      }
    }

    // Clear the subscription reference so future load() calls can create new subscriptions
    this._subscription = undefined;
    this.log.debug('Load method cleanup completed');
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

    this.log.info('Performing initial catch-up', {
      args: {
        from: queueHeight + 1,
        to: targetHeight,
        blocksCount: targetHeight - queueHeight,
      },
    });

    const heights: number[] = [];

    // Generate array of heights to fetch
    for (let height = queueHeight + 1; height <= targetHeight; height++) {
      heights.push(height);
    }

    // Fetch all blocks in a single batch request with full transactions + receipts
    const blocks = await this.blockchainProvider.getManyBlocksWithReceipts(heights, true);

    // Enqueue blocks in correct order
    await this.enqueueBlocks(blocks);

    this.log.info('Initial catch-up completed successfully', {
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
