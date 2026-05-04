import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService } from '../../../blockchain-provider/blockchain-provider.service';
import type { Block } from '../../../blockchain-provider/components/block.interfaces';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

export class SubscribeWsProviderStrategy implements BlocksLoadingStrategy {
  readonly name = StrategyNames.WS_SUBSCRIBE;
  private _subscription?: Promise<void> & { unsubscribe: () => void };
  private readonly tracesEnabled: boolean;
  private readonly verifyTrie: boolean;
  private readonly catchUpBatchSize: number;

  constructor(
    private readonly log: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRequestBlocksBatchSize?: number;
      basePreloadCount?: number;
      tracesEnabled?: boolean;
      verifyTrie?: boolean;
      catchUpBatchSize?: number;
    }
  ) {
    this.tracesEnabled = config.tracesEnabled ?? false;
    this.verifyTrie = config.verifyTrie ?? false;
    this.catchUpBatchSize = config.catchUpBatchSize ?? 50;
  }

  async load(currentNetworkHeight: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._subscription) {
        resolve();
        return;
      }

      (async () => {
        try {
          await this.performCatchUp(currentNetworkHeight);

          this._subscription = this.blockchainProvider.subscribeToNewBlocks(
            async (block) => {
              try {
                if (this.queue.isMaxHeightReached) return;
                if (this.queue.isQueueFull) {
                  this._subscription?.unsubscribe();
                  reject(new Error('Queue full'));
                  return;
                }
                if (this.tracesEnabled && block) {
                  block.traces = await this.blockchainProvider.getTracesByBlockHeight(block.blockNumber);
                }
                await this.enqueueBlock(block);
              } catch (e) {
                this._subscription?.unsubscribe();
                reject(e);
              }
            },
            true,
            this.verifyTrie
          );

          this.log.debug('WS subscription started, waiting for blocks');
          await this._subscription;
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          this.cleanup();
        }
      })();
    });
  }

  public async stop(): Promise<void> {
    this.log.debug('Stopping WS subscribe strategy');
    try {
      this._subscription?.unsubscribe();
    } catch {
      /* ignore */
    }
    this._subscription = undefined;
  }

  private cleanup(): void {
    try {
      if (typeof this._subscription?.unsubscribe === 'function') this._subscription.unsubscribe();
    } catch {
      /* ignore */
    }
    this._subscription = undefined;
  }

  private async performCatchUp(currentNetworkHeight: number): Promise<void> {
    const start = this.queue.lastHeight + 1;
    if (start > currentNetworkHeight) return;

    const gap = currentNetworkHeight - this.queue.lastHeight;
    if (gap <= this.catchUpBatchSize) {
      const heights = Array.from({ length: gap }, (_, i) => start + i);
      const blocks = await this.blockchainProvider.getManyBlocksWithReceipts(heights, true, this.verifyTrie);
      await this.attachTracesIfNeeded(blocks);
      for (const block of blocks) {
        await this.enqueueBlock(block);
      }
      return;
    }

    for (let batchStart = start; batchStart <= currentNetworkHeight; batchStart += this.catchUpBatchSize) {
      const batchEnd = Math.min(batchStart + this.catchUpBatchSize - 1, currentNetworkHeight);
      const heights = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);
      const blocks = await this.blockchainProvider.getManyBlocksWithReceipts(heights, true, this.verifyTrie);
      await this.attachTracesIfNeeded(blocks);
      for (const block of blocks) {
        await this.enqueueBlock(block);
      }
    }
  }

  private async attachTracesIfNeeded(blocks: Block[]): Promise<void> {
    if (!this.tracesEnabled) return;
    for (const block of blocks) {
      block.traces = await this.blockchainProvider.getTracesByBlockHeight(block.blockNumber);
    }
  }

  private async enqueueBlock(block: Block): Promise<void> {
    if (block.blockNumber <= this.queue.lastHeight) return;
    await this.queue.enqueue(block);
  }
}
