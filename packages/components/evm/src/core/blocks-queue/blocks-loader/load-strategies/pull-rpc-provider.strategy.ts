import type { Logger } from '@nestjs/common';
import type { BlockchainProviderService } from '../../../blockchain-provider/blockchain-provider.service';
import type { Block } from '../../../blockchain-provider/components/block.interfaces';
import type { BlocksLoadingStrategy } from './load-strategy.interface';
import { StrategyNames } from './load-strategy.interface';
import type { BlocksQueue } from '../../blocks-queue';

export class PullRpcProviderStrategy implements BlocksLoadingStrategy {
  readonly name = StrategyNames.RPC_PULL;
  private _maxRequestBlocksBatchSize: number;
  private _preloadedItemsQueue: Block[] = [];
  private _maxPreloadCount: number;
  private _lastLoadReceiptsDuration = 0;
  private _previousLoadReceiptsDuration = 0;
  private readonly tracesEnabled: boolean;

  constructor(
    private readonly log: Logger,
    private readonly blockchainProvider: BlockchainProviderService,
    private readonly queue: BlocksQueue<Block>,
    config: {
      maxRequestBlocksBatchSize: number;
      basePreloadCount: number;
      tracesEnabled?: boolean;
    }
  ) {
    this._maxRequestBlocksBatchSize = config.maxRequestBlocksBatchSize;
    this._maxPreloadCount = config.basePreloadCount;
    this.tracesEnabled = config.tracesEnabled ?? false;
  }

  public async load(currentNetworkHeight: number): Promise<void> {
    while (this.queue.lastHeight < currentNetworkHeight) {
      if (this.queue.isMaxHeightReached) return;

      if (this.queue.isQueueFull) {
        throw new Error('The queue is full, waiting before retry');
      }

      if (this._preloadedItemsQueue.length === 0) {
        await this.preloadBlocksWithTransactions(currentNetworkHeight);
      }

      if (this.queue.isQueueOverloaded(this._maxRequestBlocksBatchSize)) {
        throw new Error('The queue is overloaded, waiting before retry');
      }

      if (this._preloadedItemsQueue.length > 0) {
        await this.loadReceiptsAndEnqueueBlocks();
      }
    }
  }

  public async stop(): Promise<void> {
    this._preloadedItemsQueue = [];
  }

  private async preloadBlocksWithTransactions(currentNetworkHeight: number): Promise<void> {
    // Adaptive preload count adjustment based on timing
    if (this._previousLoadReceiptsDuration > 0 && this._lastLoadReceiptsDuration > 0) {
      const ratio = this._lastLoadReceiptsDuration / this._previousLoadReceiptsDuration;
      if (ratio > 1.2) this._maxPreloadCount = Math.round(this._maxPreloadCount * 1.25);
      else if (ratio < 0.8) this._maxPreloadCount = Math.max(1, Math.round(this._maxPreloadCount * 0.75));
    }

    const lastHeight = this.queue.lastHeight;
    const remaining = currentNetworkHeight - lastHeight;
    const count = Math.min(this._maxPreloadCount, remaining);
    if (count <= 0) return;

    const heights = Array.from({ length: count }, (_, i) => lastHeight + 1 + i);
    this._preloadedItemsQueue = await this.blockchainProvider.getManyBlocksByHeights(heights, true, true);
  }

  private async loadReceiptsAndEnqueueBlocks(): Promise<void> {
    const startTime = Date.now();
    const receiptsBatches = this.createOptimalBatchesForReceipts();
    const completeBlocks: Block[] = [];

    // Process one batch (single concurrency)
    const batch = receiptsBatches[0];
    if (batch) {
      const loaded = await this.loadBlocksWithReceipts(batch.blocks, 3);
      completeBlocks.push(...loaded);
    }

    // Clear preloaded queue
    this._preloadedItemsQueue = [];

    // Load traces if enabled (separate RPC calls per block)
    if (this.tracesEnabled && completeBlocks.length > 0) {
      await this.attachTraces(completeBlocks);
    }

    // Enqueue in order
    await this.enqueueBlocks(completeBlocks);

    // Do not clear traces here: the queue owns block objects until
    // BlocksIteratorService passes them to user models. Clearing traces after
    // enqueue breaks the TypeScript fallback queue because it stores references.

    this._previousLoadReceiptsDuration = this._lastLoadReceiptsDuration;
    this._lastLoadReceiptsDuration = Date.now() - startTime;
  }

  private createOptimalBatchesForReceipts(): { blocks: Block[]; maxPossibleSize: number }[] {
    const batches: { blocks: Block[]; maxPossibleSize: number }[] = [];
    // Sort ascending by blockNumber
    this._preloadedItemsQueue.sort((a, b) => a.blockNumber - b.blockNumber);

    let currentBatch: Block[] = [];
    let currentEstimatedSize = 0;

    for (const block of this._preloadedItemsQueue) {
      const estimated = this.estimateReceiptsSize(block);
      if (currentEstimatedSize + estimated <= this._maxRequestBlocksBatchSize || currentBatch.length === 0) {
        currentBatch.push(block);
        currentEstimatedSize += estimated;
      } else {
        batches.push({ blocks: [...currentBatch], maxPossibleSize: currentEstimatedSize });
        currentBatch = [block];
        currentEstimatedSize = estimated;
      }
    }

    if (currentBatch.length > 0) {
      batches.push({ blocks: currentBatch, maxPossibleSize: currentEstimatedSize });
    }

    return batches;
  }

  private estimateReceiptsSize(block: Block): number {
    if (!block.transactions?.length) return 0;
    const txCount = block.transactions.length;
    const blockSize = block.sizeWithoutReceipts || 0;
    if (blockSize > 2 * 1024 * 1024) return txCount * 2000;
    if (blockSize > 500 * 1024) return txCount * 1000;
    return txCount * 500;
  }

  private async loadBlocksWithReceipts(blocks: Block[], maxRetries: number): Promise<Block[]> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const heights = blocks.map((b) => b.blockNumber);
        return await this.blockchainProvider.getManyBlocksWithReceipts(heights, true, true);
      } catch (error) {
        attempt++;
        if (attempt >= maxRetries) {
          this.log.warn('Max retries exceeded for receipts batch', { args: { count: blocks.length, error } });
          throw error;
        }
        await new Promise((r) => setTimeout(r, 50 * attempt));
      }
    }
    throw new Error('Failed to fetch receipts batch');
  }

  private async attachTraces(blocks: Block[]): Promise<void> {
    for (const block of blocks) {
      block.traces = await this.blockchainProvider.getTracesByBlockHeight(block.blockNumber);
    }
  }

  private async enqueueBlocks(blocks: Block[]): Promise<void> {
    // Enqueue in ascending order
    const sorted = [...blocks].sort((a, b) => a.blockNumber - b.blockNumber);
    for (const block of sorted) {
      if (block.blockNumber <= this.queue.lastHeight) {
        this.log.debug('Skipping block below lastHeight', { args: { blockNumber: block.blockNumber } });
        continue;
      }
      await this.queue.enqueue(block);
    }
  }
}
