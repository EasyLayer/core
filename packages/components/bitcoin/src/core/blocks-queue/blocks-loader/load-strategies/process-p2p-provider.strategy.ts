import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

export class ProcessP2PProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.P2P;
  private readonly moduleName = 'blocks-queue';

  // Hold the active subscription (Promise<void> & { unsubscribe(): void }) or undefined
  private _subscription?: Promise<void> & { unsubscribe: () => void };

  /**
   * Creates an instance of ProcessP2PProviderStrategy.
   * @param logger - The application logger.
   * @param blockchainProvider - The blockchain provider service.
   * @param queue - The blocks queue.
   * @param config - Configuration object (no special config needed for P2P).
   */
  constructor(
    private readonly logger: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: any
  ) {
    // No special config needed here
  }

  /**
   * Main entrypoint:
   * - If not subscribed, performs initial catch-up to `currentNetworkHeight`.
   * - Subscribes to provider's new-block stream via P2P.
   * - Enqueues incoming blocks until stopped or an error/backpressure occurs.
   *
   * All errors (transport, block processing, setup) are logged here.
   * `subscribeToNewBlocks` only propagates errors — it does not log them.
   *
   * Contract:
   * - Resolves when subscription is gracefully stopped (via `stop()` or provider completion).
   * - Rejects on errors so the supervisor can restart the strategy with delay/jitter.
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._subscription) {
        resolve();
        return;
      }

      this.logger.verbose('P2P strategy starting', {
        module: this.moduleName,
      });

      (async () => {
        // Track whether we settled via error to avoid misleading "graceful" log
        let settledWithError = false;

        try {
          // 1) Initial one-shot catch-up to the provided network tip
          await this.performInitialCatchup(currentNetworkHeight);

          // 2) Start streaming subscription of normalized full blocks.
          //    All errors from subscribeToNewBlocks surface via onError callback.
          this._subscription = this.blockchainProvider.subscribeToNewBlocks(
            async (block) => {
              try {
                // Stop condition: upper height limit reached (external policy)
                if (this.queue.isMaxHeightReached) {
                  // Do not reject: just ignore future blocks (soft stop via supervisor)
                  return;
                }

                // Backpressure: queue is full → tear down so supervisor can retry later
                if (this.queue.isQueueFull) {
                  settledWithError = true;
                  this._subscription?.unsubscribe();
                  reject(new Error('The queue is full'));
                  return;
                }

                await this.enqueueBlock(block);
              } catch (error) {
                // Any block-processing error → tear down and bubble up for supervised restart
                this.logger.debug('P2P strategy: block processing error', {
                  module: this.moduleName,
                  args: { action: 'load', error },
                });
                settledWithError = true;
                this._subscription?.unsubscribe();
                reject(error);
              }
            },
            (subscriptionError) => {
              // Single entry point for all errors propagated from subscribeToNewBlocks:
              // transport failures (P2P disconnects), provider capability errors, etc.
              this.logger.debug('P2P strategy: subscription error', {
                module: this.moduleName,
                args: { action: 'load', error: subscriptionError },
              });
              settledWithError = true;
              try {
                this._subscription?.unsubscribe();
              } catch {
                // ignore cleanup errors
              }
              reject(subscriptionError);
            }
          );

          this.logger.debug('Waiting for new blocks', {
            module: this.moduleName,
          });

          // Wait until `unsubscribe()` is called or stream naturally completes.
          // If subscribeToNewBlocks rejects (transport error), this throws and
          // falls into the catch below — but reject() was already called via
          // onError above, so the second reject() is a safe no-op.
          await this._subscription;

          if (!settledWithError) {
            this.logger.verbose('P2P subscription completed successfully', {
              module: this.moduleName,
            });
            resolve();
          }
        } catch (setupError) {
          // Covers: performInitialCatchup failure, subscribeToNewBlocks setup rejection,
          // or the awaited subscription promise rejection surfacing here
          this.logger.verbose('P2P strategy: setup/await error', {
            module: this.moduleName,
            args: { action: 'load', error: setupError },
          });
          reject(setupError);
        } finally {
          // Always ensure resources are released regardless of exit path
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
    this.logger.verbose('Stopping P2P subscription strategy');

    if (!this._subscription) {
      this.logger.verbose('No active P2P subscription to stop');
      return;
    }

    try {
      this._subscription.unsubscribe();
      this.logger.verbose('Unsubscribed from P2P new blocks');
    } catch (error) {
      this.logger.verbose('Error while unsubscribing from P2P', {
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
          this.logger.verbose('Successfully unsubscribed from P2P block subscription');
        }
      } catch (unsubscribeError) {
        this.logger.verbose('Failed to unsubscribe from P2P block subscription', {
          args: { error: unsubscribeError },
          methodName: 'cleanup',
        });
      }
    }

    // Clear the subscription reference
    this._subscription = undefined;
    this.logger.verbose('P2P load method cleanup completed');
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

    this.logger.verbose('Performing P2P initial catch-up', {
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

    this.logger.verbose('P2P initial catch-up completed successfully', {
      args: { blocksProcessed: blocks.length },
    });
  }

  /**
   * Enqueue a single block received from subscription
   */
  private async enqueueBlock(block: Block): Promise<void> {
    if (block.height <= this.queue.lastHeight) {
      // Skip blocks with height less than or equal to lastHeight
      this.logger.verbose('Skipping block with height less than or equal to lastHeight in P2P subscription', {
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
          this.logger.verbose('Skipping block with height less than or equal to lastHeight in P2P catchup', {
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
