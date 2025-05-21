import { DynamicModule, Module, Type } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { BlockchainProviderService } from '../blockchain-provider';
import { BlocksQueueService } from './blocks-queue.service';
import { BlocksQueueIteratorService } from './blocks-iterator';
import { BlocksQueueLoaderService } from './blocks-loader';
import { BlocksCommandExecutor } from './interfaces';

export interface BlocksQueueModuleOptions {
  blocksCommandExecutor: Type<BlocksCommandExecutor>;
  basePreloadCount: number;
  maxBlockHeight: number;
  maxQueueSize: number;
  minTransferSize: number;
  queueLoaderStrategyName: string;
  queueLoaderRequestBlocksBatchSize: number;
  queueLoaderConcurrency: number;
  queueIteratorBlocksBatchSize: number;
  blockSize: number;
}

@Module({})
export class BlocksQueueModule {
  static async forRootAsync(config: BlocksQueueModuleOptions): Promise<DynamicModule> {
    const { blocksCommandExecutor, ...restConfig } = config;

    return {
      module: BlocksQueueModule,
      imports: [LoggerModule.forRoot({ componentName: BlocksQueueModule.name })],
      providers: [
        {
          // IMPORTANT: BlocksCommandExecutor is a type, so we provide token string 'BlocksCommandExecutor'
          provide: 'BlocksCommandExecutor',
          useClass: blocksCommandExecutor,
        },
        {
          provide: BlocksQueueService,
          useFactory: (logger, iterator, loader) => new BlocksQueueService(logger, iterator, loader, { ...restConfig }),
          inject: [AppLogger, BlocksQueueIteratorService, BlocksQueueLoaderService],
        },
        {
          provide: BlocksQueueLoaderService,
          useFactory: (logger, blockchainProvider) =>
            new BlocksQueueLoaderService(logger, blockchainProvider, {
              ...restConfig,
            }),
          inject: [AppLogger, BlockchainProviderService],
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (logger, executor) => new BlocksQueueIteratorService(logger, executor, { ...restConfig }),
          inject: [AppLogger, 'BlocksCommandExecutor'],
        },
      ],
      exports: [BlocksQueueService],
    };
  }
}
