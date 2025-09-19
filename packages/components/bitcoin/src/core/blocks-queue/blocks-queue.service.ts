import { Injectable, Logger } from '@nestjs/common';
import { Block } from '../blockchain-provider';
import { BlocksQueue } from './blocks-queue';
import { BlocksQueueIteratorService } from './blocks-iterator';
import { BlocksQueueLoaderService } from './blocks-loader';

@Injectable()
export class BlocksQueueService {
  logger = new Logger(BlocksQueueService.name);
  private _queue!: BlocksQueue<Block>;

  constructor(
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

    this.logger.verbose('Blocks queue service started');
  }

  private initQueue(indexedHeight: string | number) {
    this._queue = new BlocksQueue<Block>({
      lastHeight: Number(indexedHeight),
      maxQueueSize: this.config.maxQueueSize,
      maxBlockHeight: this.config.maxBlockHeight,
      blockSize: this.config.blockSize,
    });

    this.logger.debug('Queue initialized', {
      args: {
        indexedHeight,
        maxQueueSize: this.config.maxQueueSize,
        maxBlockHeight: this.config.maxBlockHeight,
        blockSize: this.config.blockSize,
      },
    });
  }

  public async reorganizeBlocks(newStartHeight: string | number): Promise<void> {
    this.logger.verbose('Reorganizing blocks', { args: { newStartHeight } });

    // NOTE: We clear the entire queue
    // because if a reorganization has occurred, this means that all the blocks in the queue
    // have already gone along the wrong chain
    await this._queue.reorganize(Number(newStartHeight));

    this.blocksQueueIterator.resolveNextBatch();

    this.logger.verbose('Queue cleared to height', {
      args: { clearedTo: newStartHeight },
    });
  }

  async confirmProcessedBatch(blockHashes: string[]): Promise<void> {
    this.logger.verbose('Confirming processed batch', {
      args: { count: blockHashes.length },
    });

    await this._queue.dequeue(blockHashes);
    this.blocksQueueIterator.resolveNextBatch();

    this.logger.verbose('Batch has been confirmed', {
      args: { count: blockHashes.length },
    });
  }

  public async getBlocksByHashes(hashes: string[]): Promise<Block[]> {
    const hashSet = new Set(hashes);
    return await this._queue.findBlocks(hashSet);
  }
}
