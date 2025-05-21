import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/common/logger';
import { Block } from '../blockchain-provider';
import { BlocksQueue } from './blocks-queue';
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

    this.log.info('Blocks queue service started');
  }

  private initQueue(indexedHeight: string | number) {
    this.log.info('Initializing queue', {
      args: { indexedHeight, maxQueueSize: this.config.maxQueueSize, maxBlockHeight: this.config.maxBlockHeight },
    });

    this._queue = new BlocksQueue<Block>(Number(indexedHeight));

    this._queue.maxQueueSize = this.config.maxQueueSize;
    this._queue.maxBlockHeight = this.config.maxBlockHeight;
    this._queue.blockSize = this.config.blockSize;

    this.log.info('Queue initialized', {
      args: {
        indexedHeight,
        maxQueueSize: this.config.maxQueueSize,
        maxBlockHeight: this.config.maxBlockHeight,
        blockSize: this.config.blockSize,
      },
    });
  }

  public async reorganizeBlocks(newStartHeight: string | number): Promise<void> {
    this.log.info('Reorganizing blocks', { args: { newStartHeight } });

    // NOTE: We clear the entire queue
    // because if a reorganization has occurred, this means that all the blocks in the queue
    // have already gone along the wrong chain
    await this._queue.reorganize(Number(newStartHeight));

    this.blocksQueueIterator.resolveNextBatch();

    this.log.info('Queue cleared to height', {
      args: { clearedTo: newStartHeight },
    });
  }

  async confirmProcessedBatch(blockHashes: string[]): Promise<Block | Block[]> {
    this.log.debug('Confirming processed batch', {
      args: { count: blockHashes.length },
    });

    const confirmedBlocks = await this._queue.dequeue(blockHashes);
    this.blocksQueueIterator.resolveNextBatch();

    this.log.debug('Batch has been confirmed', {
      args: { count: Array.isArray(confirmedBlocks) ? confirmedBlocks.length : 0 },
    });

    return confirmedBlocks || [];
  }

  public async getBlocksByHashes(hashes: string[]): Promise<Block[]> {
    const hashSet = new Set(hashes);
    return await this._queue.findBlocks(hashSet);
  }
}
