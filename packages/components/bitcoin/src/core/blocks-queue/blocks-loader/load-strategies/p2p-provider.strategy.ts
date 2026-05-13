import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService } from '../../../blockchain-provider';
import type { BlocksLoadingStrategy, Subscription } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';
import type { RawBlock } from '../../interfaces';

/**
 * P2PProviderStrategy
 *
 * Two-phase strategy that operates entirely over the P2P transport:
 *
 * Phase 1 — P2P batch catch-up:
 *   While queue.lastHeight < currentNetworkHeight, fetch blocks via P2P GetData
 *   (getManyBlocksRawByHeights → ChainTracker hash lookup + GetData batches of 128).
 *
 * Phase 2 — P2P real-time subscription:
 *   Once caught up, subscribe to the P2P block stream for real-time delivery.
 *   On any error: strategy rejects → loader supervisor resets timer → next tick restarts
 *   from Phase 1 (catch-up recovers any missed blocks).
 */
export class P2PProviderStrategy implements BlocksLoadingStrategy {
  readonly name: StrategyNames = StrategyNames.P2P;
  private readonly moduleName = 'blocks-queue';

  private _subscription?: Subscription;
  private _isBlockProcessing = false;

  constructor(
    private readonly logger: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue,
    _config?: unknown
  ) {}

  public async load(currentNetworkHeight: number): Promise<void> {
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

    if (this._subscription) {
      await this._subscription;
      return;
    }

    this.logger.debug('P2P strategy: switching to real-time subscription', {
      module: this.moduleName,
      args: { height: this.queue.lastHeight },
    });

    await this.startP2PSubscription();
  }

  public async stop(): Promise<void> {
    this._isBlockProcessing = false;
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

  private async performCatchup(targetHeight: number): Promise<void> {
    const fromHeight = this.queue.lastHeight + 1;
    const heights: number[] = [];
    for (let h = fromHeight; h <= targetHeight; h++) heights.push(h);

    const raw = await this.blockchainProvider.getManyBlocksRawByHeights(heights);
    const blocks: RawBlock[] = raw.filter(Boolean) as RawBlock[];
    await this.enqueueBlocks(blocks);
  }

  private async startP2PSubscription(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settledWithError = false;

      this._subscription = this.blockchainProvider.subscribeToNewBlocks(
        async (raw: RawBlock) => {
          if (this._isBlockProcessing) {
            this.logger.verbose('P2P strategy: block skipped (previous still processing)', {
              module: this.moduleName,
              args: { height: raw.height },
            });
            return;
          }

          this._isBlockProcessing = true;
          try {
            if (this.queue.isMaxHeightReached) return;

            if (this.queue.isQueueFull) {
              settledWithError = true;
              this._subscription?.unsubscribe();
              reject(new Error('The queue is full'));
              return;
            }

            await this.enqueueBlock(raw);
          } catch (error) {
            this.logger.verbose('P2P strategy: block processing error', {
              module: this.moduleName,
              args: { action: 'p2pBlock', error },
            });
            settledWithError = true;
            this._subscription?.unsubscribe();
            this._subscription = undefined;
            reject(error);
          } finally {
            this._isBlockProcessing = false;
          }
        },
        (subscriptionError) => {
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

      this._subscription
        .then(() => {
          this._subscription = undefined;
          if (!settledWithError) {
            this.logger.verbose('P2P subscription completed gracefully', { module: this.moduleName });
            resolve();
          }
        })
        .catch((err) => {
          this._subscription = undefined;
          if (!settledWithError) reject(err);
        });
    });
  }

  private async enqueueBlock(raw: RawBlock): Promise<void> {
    if (raw.height <= this.queue.lastHeight) {
      this.logger.verbose('P2P strategy: skipping block with height ≤ lastHeight', {
        module: this.moduleName,
        args: { blockHeight: raw.height, lastHeight: this.queue.lastHeight },
      });
      return;
    }
    await this.queue.enqueue(raw);
  }

  private async enqueueBlocks(blocks: RawBlock[]): Promise<void> {
    blocks.sort((a, b) => a.height - b.height);
    for (const block of blocks) {
      await this.enqueueBlock(block);
    }
  }
}
