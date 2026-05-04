import { DynamicModule, Module, Type } from '@nestjs/common';
import { BlockchainProviderService } from '../blockchain-provider/blockchain-provider.service';
import { BlocksQueueService } from './blocks-queue.service';
import { BlocksQueueIteratorService } from './blocks-iterator/blocks-iterator.service';
import { BlocksQueueLoaderService } from './blocks-loader/blocks-loader.service';
import { MempoolLoaderService } from './mempool-loader.service';
import type { BlocksCommandExecutor, MempoolCommandExecutor } from './interfaces';

export interface BlocksQueueModuleOptions {
  blocksCommandExecutor: Type<BlocksCommandExecutor>;
  mempoolCommandExecutor: Type<MempoolCommandExecutor>;
  basePreloadCount: number;
  maxBlockHeight: number;
  maxQueueSize: number;
  queueLoaderStrategyName: string;
  mempoolLoaderStrategyName?: 'subscribe-ws' | 'txpool-content';
  queueLoaderRequestBlocksBatchSize: number;
  queueIteratorBlocksBatchSize: number;
  blockSize: number;
  blockTimeMs: number;
  maxBlockWeight?: number;
  tracesEnabled?: boolean;
  verifyTrie?: boolean;
}

@Module({})
export class BlocksQueueModule {
  static async forRootAsync(config: BlocksQueueModuleOptions): Promise<DynamicModule> {
    const {
      blocksCommandExecutor,
      mempoolCommandExecutor,
      mempoolLoaderStrategyName = 'subscribe-ws',
      tracesEnabled = false,
      verifyTrie = false,
      ...restConfig
    } = config;

    return {
      module: BlocksQueueModule,
      imports: [],
      providers: [
        {
          provide: 'BlocksCommandExecutor',
          useClass: blocksCommandExecutor,
        },
        {
          provide: 'MempoolCommandExecutor',
          useClass: mempoolCommandExecutor,
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (executor: BlocksCommandExecutor) => new BlocksQueueIteratorService(executor, { ...restConfig }),
          inject: ['BlocksCommandExecutor'],
        },
        {
          provide: MempoolLoaderService,
          useFactory: (provider: BlockchainProviderService, executor: MempoolCommandExecutor) =>
            new MempoolLoaderService(provider, executor, mempoolLoaderStrategyName),
          inject: [BlockchainProviderService, 'MempoolCommandExecutor'],
        },
        {
          provide: BlocksQueueLoaderService,
          useFactory: (provider: BlockchainProviderService, mempoolService: MempoolLoaderService) =>
            new BlocksQueueLoaderService(provider, mempoolService, { ...restConfig, tracesEnabled, verifyTrie }),
          inject: [BlockchainProviderService, MempoolLoaderService],
        },
        {
          provide: BlocksQueueService,
          useFactory: (
            iterator: BlocksQueueIteratorService,
            loader: BlocksQueueLoaderService,
            mempoolService: MempoolLoaderService
          ) => new BlocksQueueService(iterator, loader, mempoolService, { ...restConfig, tracesEnabled, verifyTrie }),
          inject: [BlocksQueueIteratorService, BlocksQueueLoaderService, MempoolLoaderService],
        },
      ],
      exports: [BlocksQueueService, MempoolLoaderService],
    };
  }
}
