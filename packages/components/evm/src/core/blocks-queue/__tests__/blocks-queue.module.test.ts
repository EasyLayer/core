import { BlocksQueueModule } from '../blocks-queue.module';
import { BlocksQueueService } from '../blocks-queue.service';
import { MempoolLoaderService } from '../mempool-loader.service';

describe('BlocksQueueModule', () => {
  it('creates dynamic module with queue services and exports', async () => {
    class MockBlocksCommandExecutor {
      async handleBatch() {}
    }
    class MockMempoolCommandExecutor {
      async handleSnapshot() {}
    }

    const moduleRef = await BlocksQueueModule.forRootAsync({
      blocksCommandExecutor: MockBlocksCommandExecutor as any,
      mempoolCommandExecutor: MockMempoolCommandExecutor as any,
      maxBlockHeight: 10,
      maxQueueSize: 1024,
      queueLoaderStrategyName: 'rpc',
      queueLoaderRequestBlocksBatchSize: 1024,
      queueIteratorBlocksBatchSize: 1024,
      basePreloadCount: 2,
      blockSize: 512,
      blockTimeMs: 12_000,
      tracesEnabled: false,
      verifyTrie: false,
    });

    expect(moduleRef.module).toBe(BlocksQueueModule);
    expect(Array.isArray(moduleRef.providers)).toBe(true);
    expect(moduleRef.exports).toEqual(expect.arrayContaining([BlocksQueueService, MempoolLoaderService]));
  });
});
