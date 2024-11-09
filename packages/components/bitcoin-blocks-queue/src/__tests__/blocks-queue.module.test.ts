import { Test, TestingModule } from '@nestjs/testing';
import { Type } from '@nestjs/common';
import { NetworkProviderModule } from '@easylayer/components/bitcoin-network-provider';
import { LoggerModule } from '@easylayer/components/logger';
import { BlocksQueueModule, BlocksQueueModuleOptions } from '../blocks-queue.module';
import { BlocksQueueController } from '../blocks-queue.controller';
import { BlocksQueueService } from '../blocks-queue.service';
import { BlocksQueueIteratorService } from '../blocks-iterator';
import { BlocksQueueLoaderService } from '../blocks-loader';
import { BlocksCommandExecutor } from '../interfaces';

describe('BlocksQueueModule', () => {
  let module: TestingModule;

  const mockBlocksCommandExecutor: Type<BlocksCommandExecutor> = class {
    async handleBatch() {}
  };
  const moduleOptions: BlocksQueueModuleOptions = {
    blocksCommandExecutor: mockBlocksCommandExecutor,
    isTransportMode: false,
    maxBlockHeight: 1,
    queueLoaderRequestBlocksBatchSize: 10 * 1024 * 1024,
    maxQueueSize: 1024,
    minTransferSize: 1024,
    queueLoaderStrategyName: 'pull-network-provider',
    queueIteratorBlocksBatchSize: 2,
    queueLoaderConcurrency: 1,
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        // IMPORTANT: We are explicitly importing the BitcoinNetworkProviderModule for testing
        NetworkProviderModule.forRootAsync({ isGlobal: true, selfNodesUrl: 'http://localhost' }),
        BlocksQueueModule.forRootAsync(moduleOptions),
      ],
    }).compile();
  });

  it('should compile the module', async () => {
    expect(module).toBeDefined();
    expect(module.get(BlocksQueueController)).toBeInstanceOf(BlocksQueueController);
    // IMPORTANT: The queue service is accessed using a custom token
    expect(module.get('BlocksQueueService')).toBeInstanceOf(BlocksQueueService);
    expect(module.get(BlocksQueueIteratorService)).toBeInstanceOf(BlocksQueueIteratorService);
    expect(module.get(BlocksQueueLoaderService)).toBeInstanceOf(BlocksQueueLoaderService);
    expect(module.get(LoggerModule)).toBeDefined();
  });
});
