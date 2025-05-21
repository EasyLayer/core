import { v4 as uuidv4 } from 'uuid';
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { exponentialIntervalAsync, ExponentialTimer } from '@easylayer/common/exponential-interval-async';
import { AppLogger } from '@easylayer/common/logger';
import type { Block } from '../../blockchain-provider';
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

  constructor(
    private readonly log: AppLogger,
    @Inject('BlocksCommandExecutor')
    private readonly blocksCommandExecutor: BlocksCommandExecutor,
    private readonly config: any
  ) {
    this._blocksBatchSize = this.config.queueIteratorBlocksBatchSize;

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
    this._timer?.destroy();
    this._timer = null;
    this._resolveNextBatch();
    this._isIterating = false;
  }

  /**
   * Starts iterating over the block queue and processing blocks.
   */
  public async startQueueIterating(queue: BlocksQueue<Block>): Promise<void> {
    this.log.debug('Setup blocks iterating');

    // NOTE: We use this to make sure that
    // method startQueueIterating() is executed only once in its entire life.
    if (this._isIterating) {
      // Iterating Blocks already started
      return;
    }

    this._isIterating = true;

    // TODO: think where put this
    this._queue = queue;

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
      },
      {
        interval: 500,
        maxInterval: 3000,
        multiplier: 2,
      }
    );
  }

  private async processBatch(batch: Block[]) {
    // Init the promise for the next wait
    this.initBatchProcessedPromise();

    this.log.debug('Iterator process batch with length', { args: { batchLength: batch.length } });

    try {
      await this.blocksCommandExecutor.handleBatch({ batch, requestId: uuidv4() });
    } catch (error) {
      this.log.warn('Failed to process the batch', { args: error });

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
