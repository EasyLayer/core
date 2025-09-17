import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

export class ProcessP2PProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.P2P_PROCESS;

  // Hold the active subscription (Promise<void> & { unsubscribe(): void }) or undefined
  private _subscription?: Promise<void> & { unsubscribe: () => void };

  /**
   * Creates an instance of ProcessP2PProviderStrategy.
   * @param log - The application logger.
   * @param blockchainProvider - The blockchain provider service.
   * @param queue - The blocks queue.
   * @param config - Configuration object (no special config needed for P2P).
   */
  constructor(
    private readonly log: Logger,
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
   * 2. Sets up P2P subscription to new blocks
   * 3. Handles incoming blocks with termination condition checks
   * 4. Returns a Promise that resolves only when stopped or rejects on errors
   *
   * @param currentNetworkHeight - The current network block height to catch up to
   * @throws {Error} When subscription fails, queue is full, or critical errors occur
   * @returns {Promise<void>} Resolves when subscription is stopped, rejects on errors for restart
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._subscription) {
        this.log.verbose('Already subscribed to new blocks via P2P');
        resolve();
        return;
      }

      // Use async IIFE to handle async operations inside Promise
      (async () => {
        try {
          // First perform catch-up to current network height
          await this.performInitialCatchup(currentNetworkHeight);

          // Create subscription to new blocks via P2P
          this._subscription = this.blockchainProvider.subscribeToNewBlocks(async (block) => {
            try {
              if (this.queue.isMaxHeightReached) {
                // Don't unsubscribe automatically, just skip processing
                return;
              }

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

          this.log.verbose('P2P subscription created, waiting for new blocks');

          // Wait for the subscription to complete (will hang until unsubscribed, error, or termination condition)
          await this._subscription;

          this.log.verbose('P2P subscription completed successfully');
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
    this.log.verbose('Stopping P2P subscription strategy');

    if (!this._subscription) {
      this.log.verbose('No active P2P subscription to stop');
      return;
    }

    try {
      this._subscription.unsubscribe();
      this.log.verbose('Unsubscribed from P2P new blocks');
    } catch (error) {
      this.log.verbose('Error while unsubscribing from P2P', {
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
          this.log.verbose('Successfully unsubscribed from P2P block subscription');
        }
      } catch (unsubscribeError) {
        this.log.verbose('Failed to unsubscribe from P2P block subscription', {
          args: { error: unsubscribeError },
          methodName: 'cleanup',
        });
      }
    }

    // Clear the subscription reference
    this._subscription = undefined;
    this.log.verbose('P2P load method cleanup completed');
  }

  /**
   * Performs initial catch-up to synchronize queue with current network height.
   *
   * This method fetches and enqueues all blocks from (queue.lastHeight + 1) to targetHeight
   * using a single batch request to optimize network calls. All blocks are fetched with full transactions.
   *
   * @param targetHeight - The target height to catch up to (usually current network height)
   * @returns {Promise<void>} Resolves when all missing blocks are fetched and enqueued
   */
  private async performInitialCatchup(targetHeight: number): Promise<void> {
    const queueHeight = this.queue.lastHeight;

    this.log.verbose('Performing P2P initial catch-up', {
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

    // Fetch all blocks in a single batch request with full transactions and Merkle verification
    const blocks = await this.blockchainProvider.getManyBlocksByHeights(
      heights,
      true, // useHex = true for better performance and complete transaction data
      undefined, // verbosity ignored when useHex = true
      true // verifyMerkle = true for security
    );

    // Enqueue blocks in correct order
    await this.enqueueBlocks(blocks);

    this.log.verbose('P2P initial catch-up completed successfully', {
      args: { blocksProcessed: blocks.length },
    });
  }

  /**
   * Enqueue a single block received from subscription
   */
  private async enqueueBlock(block: Block): Promise<void> {
    if (block.height <= this.queue.lastHeight) {
      // Skip blocks with height less than or equal to lastHeight
      this.log.verbose('Skipping block with height less than or equal to lastHeight in P2P subscription', {
        args: {
          blockHeight: block.height,
          lastHeight: this.queue.lastHeight,
        },
      });
      return;
    }

    // In case of errors we should throw all this away without try catch
    // to reset everything and try again
    await this.queue.enqueue(block);
  }

  /**
   * Enqueue blocks in correct order (highest to lowest height for efficient popping)
   */
  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    // Sort blocks by height (highest first for popping)
    blocks.sort((a, b) => {
      if (a.height < b.height) return 1;
      if (a.height > b.height) return -1;
      return 0;
    });

    while (blocks.length > 0) {
      const block = blocks.pop();

      if (block) {
        if (block.height <= this.queue.lastHeight) {
          // Skip blocks with height less than or equal to lastHeight
          this.log.verbose('Skipping block with height less than or equal to lastHeight in P2P catchup', {
            args: {
              blockHeight: block.height,
              lastHeight: this.queue.lastHeight,
            },
          });
          continue;
        }

        // Enqueue block (throw errors up to reset everything and try again)
        await this.queue.enqueue(block);
      }
    }
  }
}
