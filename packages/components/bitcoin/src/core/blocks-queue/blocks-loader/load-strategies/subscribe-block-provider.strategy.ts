import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

/**
 * SubscribeBitcoinProviderStrategy
 *
 * Bitcoin-focused "subscribe & stream" strategy that:
 * 1) Performs a one-time initial catch-up from `queue.lastHeight+1` to `currentNetworkHeight`.
 * 2) Subscribes to new blocks from the active network provider (ZMQ/P2P).
 * 3) Immediately verifies + enqueues full normalized `Block` objects (no lazy fetches).
 * 4) Exits cleanly on backpressure (`queue.isQueueFull`) or when max height is reached.
 *
 * Notes:
 * - This strategy assumes BlockchainProviderService.subscribeToNewBlocks() delivers
 *   a fully parsed and normalized Bitcoin block (with transactions) and already
 *   verified Merkle root (the provider is doing that before normalization).
 * - Reorg-awareness: we skip any block with `height <= queue.lastHeight`.
 *   Full reorg handling (detaching/rehydrating state) is expected at higher layers.
 */
export class SubscribeBitcoinProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.SUBSCRIBE;
  private readonly moduleName = 'blocks-queue';

  // Active subscription promise with .unsubscribe() or undefined when not subscribed
  private _subscription?: Promise<void> & { unsubscribe: () => void };

  constructor(
    private readonly logger: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    _config?: unknown // no BTC-specific knobs required here; kept for symmetry
  ) {}

  /**
   * Main entrypoint:
   * - If not subscribed, performs initial catch-up to `currentNetworkHeight`.
   * - Subscribes to provider's new-block stream via ZMQ/RPC.
   * - Enqueues incoming blocks until stopped or an error/backpressure occurs.
   *
   * All errors (transport, block processing, setup) are logged here.
   * `subscribeToNewBlocks` only propagates errors — it does not log them.
   *
   * Contract:
   * - Resolves when subscription is gracefully stopped (via `stop()` or provider completion).
   * - Rejects on errors so the supervisor can restart the strategy with delay/jitter.
   */
  async load(currentNetworkHeight: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._subscription) {
        resolve();
        return;
      }

      this.logger.verbose('Subscribe strategy starting', {
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
            async (block: Block) => {
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
                  reject(new Error('Blocks queue is full'));
                  return;
                }

                await this.enqueueBlock(block);
              } catch (error) {
                // Any block-processing error → tear down and bubble up for supervised restart
                this.logger.debug('Block processing error', {
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
              // transport failures (ZMQ/P2P disconnects), provider capability errors, etc.
              this.logger.debug('Subscription error', {
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
            this.logger.verbose('Subscription completed gracefully', {
              module: this.moduleName,
            });
            resolve();
          }
        } catch (setupError) {
          // Covers: performInitialCatchup failure, subscribeToNewBlocks setup rejection,
          // or the awaited subscription promise rejection surfacing here
          this.logger.verbose('Subscribe strategy: setup/await error', {
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
   * Gracefully stops the active subscription (if any).
   * This triggers the `load()` promise to resolve.
   */
  public async stop(): Promise<void> {
    if (!this._subscription) {
      this.logger.verbose('No active BTC subscription to stop', {
        module: this.moduleName,
      });
      return;
    }

    this.logger.debug('Stopping BTC subscription strategy', {
      module: this.moduleName,
    });

    try {
      this._subscription.unsubscribe();
      this.logger.verbose('Unsubscribed from BTC new blocks', {
        module: this.moduleName,
      });
    } catch (e) {
      this.logger.verbose('Error while unsubscribing BTC', {
        module: this.moduleName,
        args: { action: 'stop', error: e },
      });
    } finally {
      this._subscription = undefined;
    }
  }

  /**
   * Initial catch-up from (queue.lastHeight+1) to targetHeight (inclusive).
   * Fetches full blocks in a single batched request and enqueues them in ascending order.
   *
   * Provider details:
   * - Uses hex path (`useHex=true`) so provider parses bytes and verifies Merkle.
   * - `verbosity` is ignored for hex path (left undefined for clarity).
   */
  private async performInitialCatchup(targetHeight: number): Promise<void> {
    const fromH = this.queue.lastHeight + 1;
    const toH = targetHeight;

    if (toH < fromH) {
      // Already caught up; nothing to do
      return;
    }

    const count = toH - fromH + 1;

    this.logger.verbose('BTC initial catch-up: requesting blocks', {
      module: this.moduleName,
      args: { from: fromH, to: toH, blocksCount: count },
    });

    const heights: number[] = [];
    for (let h = fromH; h <= toH; h++) heights.push(h);

    const blocks: Block[] = await this.blockchainProvider.getManyBlocksByHeights(
      heights,
      true, // useHex → provider decodes bytes & verifies Merkle internally
      undefined, // verbosity ignored when useHex=true
      true // verifyMerkle
    );

    await this.enqueueBlocks(blocks);

    this.logger.verbose('BTC initial catch-up completed', {
      module: this.moduleName,
      args: { blocksProcessed: blocks.length },
    });
  }

  /**
   * Enqueues a single block if it is strictly newer than the queue tip.
   * Reorg-awareness:
   * - If `block.height <= queue.lastHeight`, we skip silently.
   *   Full detach/attach logic is outside of this strategy by design.
   */
  private async enqueueBlock(block: Block): Promise<void> {
    if (block.height <= this.queue.lastHeight) {
      // May happen during reorgs or when the provider briefly replays tips
      this.logger.verbose('Skipping BTC block with height ≤ lastHeight', {
        module: this.moduleName,
        args: { blockHeight: block.height, lastHeight: this.queue.lastHeight },
      });
      return;
    }

    // No try/catch: let supervisor restart on hard failures
    await this.queue.enqueue(block);
  }

  /**
   * Enqueues a batch of blocks in ascending height order to preserve canonical sequence.
   */
  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    blocks.sort((a, b) => a.height - b.height);

    for (const b of blocks) {
      await this.enqueueBlock(b);
    }
  }

  /**
   * Cleanup helper that ensures the subscription is torn down
   * and the reference is cleared for the next `load()` call.
   */
  private cleanup(): void {
    if (this._subscription) {
      try {
        if (typeof this._subscription.unsubscribe === 'function') {
          this._subscription.unsubscribe();
          this.logger.verbose('Successfully unsubscribed from BTC block stream', {
            module: this.moduleName,
          });
        }
      } catch (unsubscribeError) {
        this.logger.verbose('Failed to unsubscribe from BTC block stream', {
          args: { action: 'cleanup', error: unsubscribeError },
        });
      }
    }
    this._subscription = undefined;
    this.logger.verbose('BTC subscription cleanup completed', {
      module: this.moduleName,
    });
  }
}
