import { DynamicModule, Logger, Module, Type } from '@nestjs/common';
import { BlockchainProviderService } from '../blockchain-provider';
import { BlocksQueueService } from './blocks-queue.service';
import { BlocksQueueIteratorService } from './blocks-iterator';
import { BlocksQueueLoaderService } from './blocks-loader';
import { BlocksCommandExecutor, MempoolCommandExecutor } from './interfaces';
import { MempoolLoaderService } from './mempool-loader.service';

export interface BlocksQueueModuleOptions {
  blocksCommandExecutor: Type<BlocksCommandExecutor>;
  mempoolCommandExecutor: Type<MempoolCommandExecutor>;
  basePreloadCount: number;
  maxBlockHeight: number;
  maxQueueSize: number;
  queueLoaderStrategyName: string;
  queueLoaderRequestBlocksBatchSize: number;
  queueIteratorBlocksBatchSize: number;
  blockSize: number;
  blockTimeMs: number;
}

@Module({})
export class BlocksQueueModule {
  private static readonly logger = new Logger(BlocksQueueModule.name);
  private static readonly moduleName = 'blocks-queue';

  static async forRootAsync(config: BlocksQueueModuleOptions): Promise<DynamicModule> {
    const { blocksCommandExecutor, mempoolCommandExecutor, ...restConfig } = config;

    this.logger.verbose('Starting blocks queue module registration', {
      module: this.moduleName,
    });

    const dynamicModule: DynamicModule = {
      module: BlocksQueueModule,
      imports: [],
      providers: [
        {
          // IMPORTANT: BlocksCommandExecutor is a type, so we provide token string 'BlocksCommandExecutor'
          provide: 'BlocksCommandExecutor',
          useClass: blocksCommandExecutor,
        },
        {
          // IMPORTANT: MempoolCommandExecutor is a type, so we provide token string 'MempoolCommandExecutor'
          provide: 'MempoolCommandExecutor',
          useClass: mempoolCommandExecutor,
        },
        {
          provide: BlocksQueueService,
          useFactory: (iterator, loader, mempoolService) =>
            new BlocksQueueService(iterator, loader, mempoolService, restConfig),
          inject: [BlocksQueueIteratorService, BlocksQueueLoaderService, MempoolLoaderService],
        },
        {
          provide: BlocksQueueLoaderService,
          useFactory: (blockchainProvider, mempoolService) =>
            new BlocksQueueLoaderService(blockchainProvider, mempoolService, restConfig),
          inject: [BlockchainProviderService, MempoolLoaderService],
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (executor) => new BlocksQueueIteratorService(executor, restConfig),
          inject: ['BlocksCommandExecutor'],
        },
        {
          provide: MempoolLoaderService,
          useFactory: (executor, provider) => new MempoolLoaderService(provider, executor),
          inject: ['MempoolCommandExecutor', BlockchainProviderService],
        },
      ],
      exports: [BlocksQueueService, MempoolLoaderService],
    };

    return dynamicModule;
  }
}
