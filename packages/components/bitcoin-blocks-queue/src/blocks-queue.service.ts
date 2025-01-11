import { Injectable } from '@nestjs/common';
import { AppLogger } from '@easylayer/components/logger';
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

    this._queue.maxQueueSize = this.config.maxQueueSize;
    this._queue.maxBlockHeight = this.config.maxBlockHeight;
  }

  public async reorganizeBlocks(newStartHeight: string | number): Promise<void> {
    // NOTE: We clear the entire queue
    // because if a reorganization has occurred, this means that all the blocks in the queue
    // have already gone along the wrong chain
    await this._queue.reorganize(Number(newStartHeight));

    this.blocksQueueIterator.resolveNextBatch();

    this.log.debug('Queue was clear to height: ', { newStartHeight }, this.constructor.name);
  }

  async confirmProcessedBatch(blockHashes: string[]): Promise<Block[]> {
    const confirmedBlocks = [];
    for (const hash of blockHashes) {
      const dequeuedBlock = await this._queue.dequeue(hash);
      confirmedBlocks.push(dequeuedBlock);
    }
    this.blocksQueueIterator.resolveNextBatch();
    return confirmedBlocks;
  }

  public async getBlocksByHashes(hashes: string[]): Promise<Block[]> {
    const hashSet = new Set(hashes);
    return await this._queue.findBlocks(hashSet);
  }
}
