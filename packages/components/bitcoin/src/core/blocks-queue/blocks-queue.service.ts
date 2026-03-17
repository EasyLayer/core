import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Block } from '../blockchain-provider';
import { BlocksQueue } from './blocks-queue';
import { BlocksQueueIteratorService } from './blocks-iterator';
import { BlocksQueueLoaderService } from './blocks-loader';
import { MempoolLoaderService } from './mempool-loader.service';

@Injectable()
export class BlocksQueueService implements OnModuleInit {
  private readonly logger = new Logger(BlocksQueueService.name);
  private readonly moduleName = 'blocks-queue';
  private _queue!: BlocksQueue<Block>;

  constructor(
    private readonly blocksQueueIterator: BlocksQueueIteratorService,
    private readonly blocksQueueLoader: BlocksQueueLoaderService,
    private readonly mempoolService: MempoolLoaderService,
    private readonly config: any
  ) {}

  onModuleInit() {
    this.logger.verbose('Blocks queue service initialized', {
      module: this.moduleName,
    });
  }

  get queue(): BlocksQueue<Block> {
    return this._queue;
  }

  async start(indexedHeight: string | number) {
    this.initQueue(indexedHeight);
    this.blocksQueueLoader.startBlocksLoading(this._queue);
    this.blocksQueueIterator.startQueueIterating(this._queue);

    this.logger.verbose('Blocks queue service started', {
      module: this.moduleName,
    });
  }

  private initQueue(indexedHeight: string | number) {
    this._queue = new BlocksQueue<Block>({
      lastHeight: Number(indexedHeight),
      maxQueueSize: this.config.maxQueueSize,
      maxBlockHeight: this.config.maxBlockHeight,
      blockSize: this.config.blockSize,
    });

    this.logger.verbose('Blocks queue initialized', {
      module: this.moduleName,
      args: {
        indexedHeight,
        maxQueueSize: this.config.maxQueueSize,
        maxBlockHeight: this.config.maxBlockHeight,
        blockSize: this.config.blockSize,
      },
    });
  }

  public async reorganizeBlocks(newStartHeight: string | number): Promise<void> {
    this.logger.verbose('Reorganizing blocks', {
      module: this.moduleName,
      args: { newStartHeight },
    });

    try {
      // NOTE: We clear the entire queue
      // because if a reorganization has occurred, this means that all the blocks in the queue
      // have already gone along the wrong chain
      await this._queue.reorganize(Number(newStartHeight));
      await this.mempoolService.refresh(Number(newStartHeight));
    } catch (error) {
      this.logger.verbose('Queue reorganization cleanup failed', {
        module: 'blocks-queue',
        args: { newStartHeight, action: 'reorganize', error },
      });
    } finally {
      this.blocksQueueIterator.resolveNextBatch();
    }
  }

  async confirmProcessedBatch(blockHashes: string[]): Promise<void> {
    this.logger.verbose('Confirming processed batch', {
      module: this.moduleName,
      args: { count: blockHashes.length },
    });

    try {
      const lastBlockHeight = await this._queue.dequeue(blockHashes);
      await this.mempoolService.refresh(lastBlockHeight);
    } catch (e) {
      this.logger.verbose('Processed batch confirmation failed', {
        module: this.moduleName,
        args: { count: blockHashes.length, action: 'confirm', error: e },
      });
    } finally {
      this.blocksQueueIterator.resolveNextBatch();
    }
  }

  public async getBlocksByHashes(hashes: string[]): Promise<Block[]> {
    const hashSet = new Set(hashes);
    return await this._queue.findBlocks(hashSet);
  }
}
