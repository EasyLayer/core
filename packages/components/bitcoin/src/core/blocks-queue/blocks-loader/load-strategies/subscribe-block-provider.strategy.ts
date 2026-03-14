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

  // Active subscription promise with .unsubscribe() or undefined when not subscribed
  private _subscription?: Promise<void> & { unsubscribe: () => void };

  constructor(
    private readonly log: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    _config?: unknown // no BTC-specific knobs required here; kept for symmetry
  ) {}

  /**
   * Main entrypoint:
   * - If not subscribed, performs initial catch-up to `currentNetworkHeight`.
   * - Subscribes to provider's new-block stream.
   * - Enqueues incoming blocks until stopped or an error/backpressure occurs.
   *
   * Contract:
   * - Resolves when subscription is gracefully stopped (via `stop()` or provider completion).
   * - Rejects on errors so the supervisor can restart the strategy with delay/jitter.
   */
  async load(currentNetworkHeight: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._subscription) {
        this.log.debug('BTC subscribe strategy: already subscribed; skipping re-subscribe');
        resolve();
        return;
      }

      (async () => {
        try {
          // 1) Initial one-shot catch-up to the provided network tip
          await this.performInitialCatchup(currentNetworkHeight);

          // 2) Start streaming subscription of normalized full blocks
          this._subscription = this.blockchainProvider.subscribeToNewBlocks(
            async (block: Block) => {
              try {
                // Stop condition: upper height limit reached (external policy)
                if (this.queue.isMaxHeightReached) {
                  // Do not reject: just ignore future blocks (soft stop via supervisor)
                  return;
                }

                // IMPORTANT: we don't need to check currentNetworkHeight here
                // because we subscribe on new blocks

                // Backpressure: if queue is full, tear down subscription so supervisor can retry later
                if (this.queue.isQueueFull) {
                  this._subscription?.unsubscribe();
                  reject(new Error('The queue is full'));
                  return;
                }

                await this.enqueueBlock(block);
              } catch (err) {
                // Any processing error should tear down subscription and bubble up
                this._subscription?.unsubscribe();
                reject(err as Error);
              }
            },
            (transportError) => {
              // Transport failures (ZMQ/P2P disconnects, etc.) → bubble up for supervised restart
              this.log.warn('BTC subscription transport error', {
                args: { error: transportError },
                methodName: 'load',
              });
              try {
                this._subscription?.unsubscribe();
              } catch {
                // ignore
              }
              reject(transportError);
            }
          );

          this.log.debug('BTC subscription started; waiting for new blocks');

          // Wait until `unsubscribe()` is called or stream naturally completes
          await this._subscription;

          this.log.debug('BTC subscription completed gracefully');
          resolve();
        } catch (setupError) {
          reject(setupError as Error);
        } finally {
          // Always ensure resources are released
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
    this.log.debug('Stopping BTC subscription strategy');

    if (!this._subscription) {
      this.log.debug('No active BTC subscription to stop');
      return;
    }

    try {
      this._subscription.unsubscribe();
      this.log.debug('Unsubscribed from BTC new blocks');
    } catch (e) {
      this.log.debug('Error while unsubscribing BTC', {
        args: { error: e },
        methodName: 'stop',
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

    this.log.debug('BTC initial catch-up: requesting blocks', {
      args: { from: fromH, to: toH, blocksCount: count },
      methodName: 'performInitialCatchup',
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

    this.log.debug('BTC initial catch-up completed', {
      args: { blocksProcessed: blocks.length },
      methodName: 'performInitialCatchup',
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
      this.log.debug('Skipping BTC block with height ≤ lastHeight', {
        args: { blockHeight: block.height, lastHeight: this.queue.lastHeight },
        methodName: 'enqueueBlock',
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
          this.log.debug('Successfully unsubscribed from BTC block stream');
        }
      } catch (unsubscribeError) {
        this.log.debug('Failed to unsubscribe from BTC block stream', {
          args: { error: unsubscribeError },
          methodName: 'cleanup',
        });
      }
    }
    this._subscription = undefined;
    this.log.debug('BTC subscription cleanup completed');
  }
}
