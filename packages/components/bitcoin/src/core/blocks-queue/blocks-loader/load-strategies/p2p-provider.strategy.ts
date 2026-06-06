import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService, IncomingRawBlock } from '../../../blockchain-provider';
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
    const targetHeight = Math.min(currentNetworkHeight, this.queue.maxBlockHeight);

    if (this.queue.lastHeight < targetHeight) {
      this.logger.verbose('P2P strategy: starting catch-up', {
        module: this.moduleName,
        args: {
          from: this.queue.lastHeight + 1,
          to: targetHeight,
          blocksCount: targetHeight - this.queue.lastHeight,
        },
      });

      await this.performCatchup(targetHeight);

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
        async (raw: IncomingRawBlock) => {
          if (this._isBlockProcessing) {
            this.logger.verbose('P2P strategy: block skipped (previous still processing)', {
              module: this.moduleName,
              args: { hash: raw.hash, prevHash: raw.prevHash },
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

            await this.enqueueLiveBlock(raw);
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

  private async enqueueLiveBlock(raw: IncomingRawBlock): Promise<void> {
    const tipHash = await this.ensureQueueTipHashForLive();
    const expectedHeight = this.queue.lastHeight + 1;

    if (raw.prevHash !== tipHash) {
      throw new Error(
        `P2P strategy: live block continuity mismatch: prevHash=${raw.prevHash}, expectedTipHash=${tipHash}, incomingHash=${raw.hash}, expectedHeight=${expectedHeight}`
      );
    }

    await this.enqueueBlock({
      hash: raw.hash,
      prevHash: raw.prevHash,
      height: expectedHeight,
      size: raw.size,
      bytes: raw.bytes,
    });
  }

  private async ensureQueueTipHashForLive(): Promise<string> {
    if (this.queue.lastHash) return this.queue.lastHash;

    const lastHeight = this.queue.lastHeight;
    if (!Number.isFinite(lastHeight) || lastHeight < 0) {
      throw new Error(`P2P strategy: cannot start live subscription without a known queue height`);
    }

    const tipHash = await this.blockchainProvider.getOneBlockHashByHeight(lastHeight);
    if (!tipHash) {
      throw new Error(`P2P strategy: cannot start live subscription without tip hash for height ${lastHeight}`);
    }

    this.queue.setLastHashForContinuity(tipHash);
    return tipHash;
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
