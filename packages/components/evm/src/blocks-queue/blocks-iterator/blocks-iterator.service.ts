import { v4 as uuidv4 } from 'uuid';
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import { Block } from '../../blockchain-provider';
import { BlocksQueue } from '../blocks-queue';
import type { BlocksCommandExecutor } from '../interfaces';

@Injectable()
export class BlocksQueueIteratorService implements OnModuleDestroy {
  private _queue!: BlocksQueue<Block>;
  private _isIterating: boolean = false;
  private batchProcessedPromise!: Promise<void>;
  protected _resolveNextBatch!: () => void;
  private _blocksBatchSize: number = 1024;
  private _timer: ExponentialTimer | null = null;
  private readonly _monitoringInterval: number;

  constructor(
    private readonly log: AppLogger,
    @Inject('BlocksCommandExecutor')
    private readonly blocksCommandExecutor: BlocksCommandExecutor,
    private readonly config: any
  ) {
    this._blocksBatchSize = this.config.queueIteratorBlocksBatchSize;

    // Calculate monitoring interval once in constructor
    // Half of block time, minimum 30 seconds
    this._monitoringInterval = Math.max(this.config.blockTimeMs / 2, 1000);

    // TODO: This should be removed when we figure out where to initialize the queue correctly.
    // Now, without this line, we can get a situation where the queue is not initialized
    // (method startQueueIterating() is not called),
    // and method _resolveNextBatch() is provided in the getter, which will cause an error.
    this._resolveNextBatch = () => {};
  }

  get resolveNextBatch() {
    return this._resolveNextBatch;
  }

  get isIterating() {
    return this._isIterating;
  }

  onModuleDestroy() {
    this.log.debug('Shutting down iterator');
    this._timer?.destroy();
    this._timer = null;
    this._resolveNextBatch();
    this._isIterating = false;
  }

  /**
   * Starts iterating over the block queue and processing blocks.
   */
  public async startQueueIterating(queue: BlocksQueue<Block>): Promise<void> {
    this.log.debug('Start blocks iterating', {
      args: { initialQueueLength: queue.length },
    });

    // NOTE: We use this to make sure that
    // method startQueueIterating() is executed only once in its entire life.
    if (this._isIterating) {
      this.log.debug('Blocks iterating skipped: already iterating');
      // Iterating Blocks already started
      return;
    }

    this._isIterating = true;

    // TODO: think where put this
    this._queue = queue;

    this.log.debug('Queue assigned to iterator', {
      args: { currentSize: this._queue.currentSize },
    });

    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        // IMPORTANT: Before processing the next batch from the queue,
        // we wait for the resolving of the promise of the previous batch (confirm batch method)
        await this.batchProcessedPromise;

        this.log.debug('Previous batch resolved, fetching next batch');

        const batch = await this.peekNextBatch();

        if (batch.length > 0) {
          await this.processBatch(batch);
          this.log.debug('Batch processed, resetting interval');
          resetInterval();
        } else {
          this.log.debug('No blocks to process this tick');
        }
      },
      {
        interval: 1000, // Start with 1000ms for first attempts
        maxInterval: this._monitoringInterval, // Max interval = monitoring interval (half block time)
        multiplier: 2, // Exponential backoff multiplier
      }
    );

    this.log.debug('Iterator exponential timer started');
  }

  private async processBatch(batch: Block[]) {
    // Init the promise for the next wait
    this.initBatchProcessedPromise();

    this.log.debug('Iterator process batch with length', { args: { batchLength: batch.length } });

    try {
      await this.blocksCommandExecutor.handleBatch({ batch, requestId: uuidv4() });

      this.log.debug('handleBatch succeeded');
    } catch (error) {
      this.log.debug('Failed to process the batch, will retry', {
        methodName: 'processBatch',
        args: error,
      });

      // IMPORTANT: We call this to resolve queue promise
      // that we can try same block one more time
      this._resolveNextBatch();
    }
  }

  /**
   * Retrieves the next batch of blocks for processing.
   *
   * Uses maximum batch size approach to ensure optimal performance:
   * - Always processes available blocks (guarantees progress)
   * - Respects memory limits by not exceeding maximum batch size
   * - Prevents resource starvation by taking all available blocks up to the limit
   *
   * This approach is better than minimum batch size because:
   * - No deadlock when blocks are smaller than minimum threshold
   * - Efficient resource utilization
   * - Predictable performance characteristics
   *
   * @returns Promise resolving to array of blocks ready for processing
   */
  private async peekNextBatch(): Promise<Block[]> {
    // Maximum batch size in bytes - this is our memory/processing limit
    const maxBatchSize = this._blocksBatchSize;

    // Get all available blocks up to the maximum size limit
    // This ensures we always make progress while respecting resource constraints
    const batch: Block[] = await this._queue.getBatchUpToSize(maxBatchSize);

    this.log.debug('Fetched batch for processing', {
      args: {
        batchLength: batch.length,
        maxBatchSize,
        totalBatchSize: batch.reduce((sum, block) => sum + block.size, 0),
      },
    });

    return batch;
  }

  private initBatchProcessedPromise(): void {
    this.batchProcessedPromise = new Promise<void>((resolve) => {
      this._resolveNextBatch = resolve;
    });
    if (this._queue.length === 0) {
      this._resolveNextBatch();
    }
  }
}
