import { Injectable } from '@nestjs/common';
import { AppLogger, RuntimeTracker } from '@easylayer/components/logger';
import { BlocksQueue } from './blocks-queue';
import { Block } from './interfaces';
import { BlocksQueueIteratorService } from './blocks-iterator';
import { BlocksQueueLoaderService } from './blocks-loader';

@Injectable()
export class BlocksQueueService {
  private _queue!: BlocksQueue<Block>;

  constructor(
    private readonly log: AppLogger,
    private readonly blocksQueueIterator: BlocksQueueIteratorService,
    private readonly blocksQueueLoader: BlocksQueueLoaderService,
    private readonly config: any
  ) {}

  get queue(): BlocksQueue<Block> {
    return this._queue;
  }

  async start(indexedHeight: string | number) {
    this.initQueue(indexedHeight);
    this.blocksQueueLoader.startBlocksLoading(this._queue);
    this.blocksQueueIterator.startQueueIterating(this._queue);
  }

  private initQueue(indexedHeight: string | number) {
    this._queue = new BlocksQueue<Block>(Number(indexedHeight));

    this._queue.minTransferSize = this.config.minTransferSize;
    this._queue.maxQueueSize = this.config.maxQueueSize;
    this._queue.maxBlockHeight = this.config.maxBlockHeight;
  }

  public async reorganizeBlocks(newStartHeight: string | number): Promise<void> {
    // NOTE: We clear the entire queue
    // because if a reorganization has occurred, this means that all the blocks in the queue
    // have already gone along the wrong chain
    this._queue.reorganize(Number(newStartHeight));

    this.blocksQueueIterator.resolveNextBatch();

    this.log.info('Queue was clear to height: ', { newStartHeight }, this.constructor.name);
  }

  @RuntimeTracker({ showMemory: true, warningThresholdMs: 10, errorThresholdMs: 1000 })
  public async confirmProcessedBatch(blockHashes: string[]): Promise<Block[]> {
    const confirmedBlocks: Block[] = [];

    for (const hash of blockHashes) {
      const block = await this._queue.firstBlock();

      if (block && block.hash === hash) {
        const dequeuedBlock = await this._queue.dequeue();

        if (!dequeuedBlock) {
          throw new Error(`Block not found in the queue after dequeue: ${hash}`);
        }

        confirmedBlocks.push(dequeuedBlock);
      } else {
        // If the block is not found or the hash does not match, throw an error
        throw new Error(`Block not found or hash mismatch: ${hash}`);
      }
    }

    // Allow the next batch to be processed
    this.blocksQueueIterator.resolveNextBatch();

    return confirmedBlocks;
  }

  public getBlocksByHashes(hashes: string[]): Block[] {
    const hashSet = new Set(hashes);

    return this._queue.findBlocks(hashSet);
  }
}
