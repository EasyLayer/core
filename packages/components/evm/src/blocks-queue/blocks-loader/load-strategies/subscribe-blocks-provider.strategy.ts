import type { AppLogger } from '@easylayer/common/logger';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from '../load-strategies';
import type { BlocksQueue } from '../../blocks-queue';

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
   * Sets up a WebSocket-based subscription to new blocks and waits for completion.
   * If already subscribed, it simply returns.
   *
   * For every incoming block:
   * 1. If block.blockNumber ≤ queue.lastHeight, skip it
   * 2. Otherwise, enqueue it
   * 3. Check termination conditions (target height, queue full, etc.)
   * 4. Throw errors to terminate the load() method when needed
   *
   * @param currentNetworkHeight - The current network block height to compare against
   * @throws {Error} When subscription fails, queue is full, or other error conditions are met
   * @returns {Promise<void>} Resolves when subscription completes normally or meets completion conditions
   */
  async load(currentNetworkHeight: number): Promise<void> {
    if (this._subscription) {
      this.log.debug(`Already subscribed to new blocks`);
      return;
    }

    try {
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
        await this.queue.enqueue(block);
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
          this.log.error(`Failed to unsubscribe from block subscription`, {
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
   * Cancels the existing subscription (if any). Calls `unsubscribe()` on the stored promise,
   * which removes the WebSocket listener and resolves that promise.
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
}
