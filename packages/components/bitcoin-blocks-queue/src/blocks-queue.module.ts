import { DynamicModule, Module, Type } from '@nestjs/common';
import { NetworkProviderService } from '@easylayer/components/bitcoin-network-provider';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { BlocksQueueController } from './blocks-queue.controller';
import { BlocksQueueService } from './blocks-queue.service';
import { BlocksQueueIteratorService } from './blocks-iterator';
import { BlocksQueueLoaderService } from './blocks-loader';
import { BlocksCommandExecutor } from './interfaces';

export interface BlocksQueueModuleOptions {
  blocksCommandExecutor: Type<BlocksCommandExecutor>;
  isTransportMode: boolean; // TODO: remove
  isTest?: boolean;
  maxBlockHeight: number;
  maxQueueSize: number;
  minTransferSize: number;
  queueLoaderStrategyName: string;
  queueLoaderRequestBlocksBatchSize: number;
  queueLoaderConcurrency: number;
  queueIteratorBlocksBatchSize: number;
}

@Module({})
export class BlocksQueueModule {
  static async forRootAsync(config: BlocksQueueModuleOptions): Promise<DynamicModule> {
    const { blocksCommandExecutor, ...restConfig } = config;

    return {
      module: BlocksQueueModule,
      controllers: [BlocksQueueController],
      imports: [LoggerModule.forRoot({ componentName: 'BitcoinBlocksQueueComponent' })],
      providers: [
        {
          // IMPORTANT:
          provide: 'BlocksCommandExecutor',
          useClass: blocksCommandExecutor,
        },
        {
          provide: 'BlocksQueueService',
          useFactory: (logger, iterator, loader) => new BlocksQueueService(logger, iterator, loader, { ...restConfig }),
          inject: [AppLogger, BlocksQueueIteratorService, BlocksQueueLoaderService],
        },
        {
          provide: BlocksQueueLoaderService,
          useFactory: (logger, networkProvider) =>
            new BlocksQueueLoaderService(logger, networkProvider, {
              ...restConfig,
            }),
          inject: [AppLogger, NetworkProviderService],
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (logger, executor) => new BlocksQueueIteratorService(logger, executor, { ...restConfig }),
          inject: [AppLogger, 'BlocksCommandExecutor'],
        },
      ],
      exports: ['BlocksQueueService'],
    };
  }
}
