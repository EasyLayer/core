import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, Block } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy, Subscription } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

/**
 * P2PProviderStrategy
 *
 * Two-phase strategy that operates entirely over the P2P transport:
 *
 * Phase 1 — P2P batch catch-up:
 *   While queue.lastHeight < currentNetworkHeight, fetch blocks via P2P GetData
 *   (getManyBlocksByHeights → ChainTracker hash lookup + GetData batches of 128).
 *   Requires header sync to be complete so ChainTracker can resolve heights → hashes.
 *
 * Phase 2 — P2P real-time subscription:
 *   Once caught up, subscribe to the P2P block stream for real-time delivery.
 *   On any error (peer disconnect, block processing failure, backpressure):
 *   strategy rejects → loader supervisor resets timer → next tick restarts
 *   from Phase 1 (catch-up recovers any missed blocks).
 *
 * Note: Both phases use the same underlying P2PTransport. The transport must
 * support subscribeToNewBlocks (peer block events) for Phase 2.
 */
export class P2PProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.P2P;
  private readonly moduleName = 'blocks-queue';

  // Active P2P block subscription (Phase 2), if any
  private _subscription?: Subscription;

  constructor(
    private readonly logger: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    _config?: unknown // no extra config needed; kept for factory symmetry
  ) {}

  /**
   * Phase 1: P2P batch catch-up to currentNetworkHeight.
   * Phase 2: P2P real-time subscription until disconnect or stop().
   */
  public async load(currentNetworkHeight: number): Promise<void> {
    // Phase 1: catch-up via P2P GetData batches
    if (this.queue.lastHeight < currentNetworkHeight) {
      this.logger.verbose('P2P strategy: starting catch-up', {
        module: this.moduleName,
        args: {
          from: this.queue.lastHeight + 1,
          to: currentNetworkHeight,
          blocksCount: currentNetworkHeight - this.queue.lastHeight,
        },
      });

      await this.performCatchup(currentNetworkHeight);

      this.logger.verbose('P2P strategy: catch-up complete', {
        module: this.moduleName,
        args: { lastHeight: this.queue.lastHeight },
      });
    }

    // Phase 2: caught up — subscribe to P2P stream if not already active
    if (this._subscription) {
      // Already subscribed — block until disconnect or stop()
      await this._subscription;
      return;
    }

    this.logger.debug('P2P strategy: switching to real-time subscription', {
      module: this.moduleName,
      args: { height: this.queue.lastHeight },
    });

    await this.startP2PSubscription();
  }

  /**
   * Stop both catch-up and any active P2P subscription.
   */
  public async stop(): Promise<void> {
    if (this._subscription) {
      try {
        this._subscription.unsubscribe();
      } catch {
        // ignore cleanup errors
      }
      this._subscription = undefined;
    }

    this.logger.verbose('P2P strategy stopped', { module: this.moduleName });
  }

  // ===== PHASE 1: P2P GetData catch-up =====

  /**
   * Fetch all blocks [queue.lastHeight+1 .. targetHeight] via P2P GetData.
   * getManyBlocksByHeights uses:
   *   - P2PTransport.getManyBlockHashesByHeights → ChainTracker local lookup O(1) per height
   *   - P2PTransport.requestHexBlocks → GetData batches of 128 with hash→position mapping
   */
  private async performCatchup(targetHeight: number): Promise<void> {
    const fromHeight = this.queue.lastHeight + 1;
    const heights: number[] = [];
    for (let h = fromHeight; h <= targetHeight; h++) heights.push(h);

    const blocks = await this.blockchainProvider.getManyBlocksByHeights(
      heights,
      true, // useHex → P2P bytes path
      undefined, // verbosity ignored for hex path
      true // verifyMerkle
    );

    await this.enqueueBlocks(blocks);
  }

  // ===== PHASE 2: P2P real-time subscription =====

  private async startP2PSubscription(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settledWithError = false;

      this._subscription = this.blockchainProvider.subscribeToNewBlocks(
        async (block: Block) => {
          try {
            if (this.queue.isMaxHeightReached) return;

            if (this.queue.isQueueFull) {
              settledWithError = true;
              this._subscription?.unsubscribe();
              reject(new Error('The queue is full'));
              return;
            }

            await this.enqueueBlock(block);
          } catch (error) {
            this.logger.verbose('P2P strategy: block processing error', {
              module: this.moduleName,
              args: { action: 'p2pBlock', error },
            });
            settledWithError = true;
            this._subscription?.unsubscribe();
            this._subscription = undefined;
            reject(error);
          }
        },
        (subscriptionError) => {
          // Peer disconnected or transport error
          this.logger.verbose('P2P strategy: subscription error', {
            module: this.moduleName,
            args: { action: 'p2pError', error: subscriptionError },
          });
          settledWithError = true;
          try {
            this._subscription?.unsubscribe();
          } catch {
            /* ignore */
          }
          this._subscription = undefined;
          reject(subscriptionError);
        }
      );

      // Wait until unsubscribe() resolves or onError rejects
      this._subscription
        .then(() => {
          this._subscription = undefined;
          if (!settledWithError) {
            this.logger.verbose('P2P subscription completed gracefully', {
              module: this.moduleName,
            });
            resolve();
          }
        })
        .catch((err) => {
          this._subscription = undefined;
          if (!settledWithError) reject(err);
        });
    });
  }

  // ===== SHARED HELPERS =====

  private async enqueueBlock(block: Block): Promise<void> {
    if (block.height <= this.queue.lastHeight) {
      this.logger.verbose('P2P strategy: skipping block with height ≤ lastHeight', {
        module: this.moduleName,
        args: { blockHeight: block.height, lastHeight: this.queue.lastHeight },
      });
      return;
    }
    // No try/catch — let errors propagate so supervisor resets the timer
    await this.queue.enqueue(block);
  }

  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    blocks.sort((a, b) => a.height - b.height);
    for (const block of blocks) {
      await this.enqueueBlock(block);
    }
  }
}
