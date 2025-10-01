import { DynamicModule, Module, Type } from '@nestjs/common';
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
  queueLoaderStrategyName: string;
  queueLoaderRequestBlocksBatchSize: number;
  queueIteratorBlocksBatchSize: number;
  blockSize: number;
  blockTimeMs: number;
}

@Module({})
export class BlocksQueueModule {
  static async forRootAsync(config: BlocksQueueModuleOptions): Promise<DynamicModule> {
    const { blocksCommandExecutor, ...restConfig } = config;

    return {
      module: BlocksQueueModule,
      imports: [],
      providers: [
        {
          // IMPORTANT: BlocksCommandExecutor is a type, so we provide token string 'BlocksCommandExecutor'
          provide: 'BlocksCommandExecutor',
          useClass: blocksCommandExecutor,
        },
        {
          provide: BlocksQueueService,
          useFactory: (iterator, loader) => new BlocksQueueService(iterator, loader, { ...restConfig }),
          inject: [BlocksQueueIteratorService, BlocksQueueLoaderService],
        },
        {
          provide: BlocksQueueLoaderService,
          useFactory: (blockchainProvider) =>
            new BlocksQueueLoaderService(blockchainProvider, {
              ...restConfig,
            }),
          inject: [BlockchainProviderService],
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (executor) => new BlocksQueueIteratorService(executor, { ...restConfig }),
          inject: ['BlocksCommandExecutor'],
        },
      ],
      exports: [BlocksQueueService],
    };
  }
}
