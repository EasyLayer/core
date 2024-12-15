import { v4 as uuidv4 } from 'uuid';
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/components/logger';
import { BlocksQueue } from '../blocks-queue';
import { Block, BlocksCommandExecutor } from '../interfaces';

@Injectable()
export class BlocksQueueIteratorService implements OnModuleDestroy {
  private _queue!: BlocksQueue<Block>;
  private _isIterating: boolean = false;
  private batchProcessedPromise!: Promise<void>;
  protected _resolveNextBatch!: () => void;
  private _blocksBatchSize: number = 1024;
  private _timer: ExponentialTimer | null = null;

  constructor(
    private readonly log: AppLogger,
    @Inject('BlocksCommandExecutor')
    private readonly blocksCommandExecutor: BlocksCommandExecutor,
    private readonly config: any
  ) {
    this._blocksBatchSize = this.config.queueIteratorBlocksBatchSize;
  }

  get resolveNextBatch() {
    return this._resolveNextBatch;
  }

  get isIterating() {
    return this._isIterating;
  }

  onModuleDestroy() {
    this._timer?.destroy();
    this._timer = null;
    this._isIterating = false;
    this._resolveNextBatch();
  }

  /**
   * Starts iterating over the block queue and processing blocks.
   */
  public async startQueueIterating(queue: BlocksQueue<Block>): Promise<void> {
    this.log.info('Setup blocks iterating', {}, this.constructor.name);

    // NOTE: We use this to make sure that
    // method startQueueIterating() is executed only once in its entire life.
    if (this._isIterating) {
      // Iterating Blocks already started
      return;
    }

    this._isIterating = true;

    // TODO: think where put this
    this._queue = queue;

    this.initBatchProcessedPromise();

    this._timer = exponentialIntervalAsync(
      async (resetInterval) => {
        // IMPORTANT: Before processing the next batch from the queue,
        // we wait for the resolving of the promise of the previous batch (confirm batch method)
        await this.batchProcessedPromise;

        const batch = await this.peekNextBatch();

        if (batch.length > 0) {
          await this.processBatch(batch);
          resetInterval();
        }
        // else {
        //   this.log.debug(
        //     'Queue is empty. Waiting...',
        //     { queueLastHeight: this._queue.lastHeight },
        //     this.constructor.name
        //   );
        // }
      },
      {
        interval: 1,
        maxInterval: 3000,
        multiplier: 2,
      }
    );
  }

  private async processBatch(batch: Block[]) {
    // Init the promise for the next wait
    this.initBatchProcessedPromise();

    this.log.debug('Iterator process batch with length', { batchLength: batch.length }, this.constructor.name);

    try {
      await this.blocksCommandExecutor.handleBatch({ batch, requestId: uuidv4() });
    } catch (error) {
      this.log.error('Failed to process the batch', error, this.constructor.name);

      // IMPORTANT: We call this to resolve queue promise
      // that we can try same block one more time
      this._resolveNextBatch();
    }
  }

  private async peekNextBatch(): Promise<Block[]> {
    // Minimum batch size in bytes
    const minBatchSize = this._blocksBatchSize;

    // Now we start processing blocks only in batches of the appropriate sizes.
    // If there are few blocks in the queue, we will not take them out for now in order to unload other places.
    const batch: Block[] = await this._queue.getBatchUpToSize(minBatchSize);

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
