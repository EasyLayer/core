import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService } from '../../../blockchain-provider/blockchain-provider.service';
import type { Block } from '../../../blockchain-provider/components/block.interfaces';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

/**
 * WS subscription strategy for real-time block ingestion.
 *
 * On start:
 *   1. Catch-up: fetch missed blocks (batched like pull-rpc for large gaps)
 *   2. Subscribe to newBlocks via WebSocket
 *
 * Catch-up threshold: if gap > CATCH_UP_BATCH_THRESHOLD, use batched loading
 * instead of single getManyBlocksWithReceipts call to avoid OOM.
 */
export class SubscribeWsProviderStrategy implements BlocksLoadingStrategy {
  readonly name = StrategyNames.WS_SUBSCRIBE;
  private _subscription?: Promise<void> & { unsubscribe: () => void };
  private readonly tracesEnabled: boolean;
  private readonly catchUpBatchSize: number;

  constructor(
    private readonly log: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRequestBlocksBatchSize?: number;
      basePreloadCount?: number;
      tracesEnabled?: boolean;
      catchUpBatchSize?: number;
    }
  ) {
    this.tracesEnabled = config.tracesEnabled ?? false;
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
                // Add traces if enabled
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
            true
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

  /**
   * Fetch missed blocks from queue.lastHeight+1 to targetHeight.
   * For small gaps (≤ catchUpBatchSize): single request.
   * For large gaps: batched loading to avoid memory issues.
   */
  private async performCatchUp(targetHeight: number): Promise<void> {
    const from = this.queue.lastHeight + 1;
    const gap = targetHeight - this.queue.lastHeight;

    if (gap <= 0) return;

    this.log.debug('WS catch-up', { args: { from, to: targetHeight, gap } });

    if (gap <= this.catchUpBatchSize) {
      // Small gap: single request
      const heights = Array.from({ length: gap }, (_, i) => from + i);
      const blocks = await this.blockchainProvider.getManyBlocksWithReceipts(heights, true, true);
      if (this.tracesEnabled) await this.attachTraces(blocks);
      await this.enqueueBlocks(blocks);
    } else {
      // Large gap: batched like pull-rpc to avoid OOM
      let current = from;
      while (current <= targetHeight) {
        const batchEnd = Math.min(current + this.catchUpBatchSize - 1, targetHeight);
        const heights = Array.from({ length: batchEnd - current + 1 }, (_, i) => current + i);
        const blocks = await this.blockchainProvider.getManyBlocksWithReceipts(heights, true, true);
        if (this.tracesEnabled) await this.attachTraces(blocks);
        await this.enqueueBlocks(blocks);
        current = batchEnd + 1;
      }
    }

    this.log.debug('WS catch-up completed', { args: { processed: gap } });
  }

  private async attachTraces(blocks: Block[]): Promise<void> {
    for (const block of blocks) {
      block.traces = await this.blockchainProvider.getTracesByBlockHeight(block.blockNumber);
    }
  }

  private async enqueueBlock(block: Block): Promise<void> {
    if (!block || block.blockNumber <= this.queue.lastHeight) return;
    await this.queue.enqueue(block);
  }

  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    const sorted = [...blocks].sort((a, b) => a.blockNumber - b.blockNumber);
    for (const block of sorted) await this.enqueueBlock(block);
  }
}
