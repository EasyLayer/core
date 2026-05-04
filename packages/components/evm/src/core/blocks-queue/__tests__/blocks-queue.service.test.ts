import { BlocksQueueService } from '../blocks-queue.service';
import type { BlocksQueue } from '../blocks-queue';
import type { Block } from '../../blockchain-provider/components/block.interfaces';
import type { BlocksQueueIteratorService } from '../blocks-iterator/blocks-iterator.service';
import type { BlocksQueueLoaderService } from '../blocks-loader/blocks-loader.service';
import type { MempoolLoaderService } from '../mempool-loader.service';

describe('BlocksQueueService', () => {
  let service: BlocksQueueService;
  let mockIterator: jest.Mocked<Pick<BlocksQueueIteratorService, 'startQueueIterating' | 'resolveNextBatch'>>;
  let mockLoader: jest.Mocked<Pick<BlocksQueueLoaderService, 'startBlocksLoading'>>;
  let mockMempoolLoader: jest.Mocked<Pick<MempoolLoaderService, 'refresh'>>;
  let mockQueue: Partial<BlocksQueue<Block>>;

  const config = {
    maxQueueSize: 10_000_000,
    maxBlockHeight: Number.MAX_SAFE_INTEGER,
    blockSize: 1000,
    maxBlockWeight: 4_000_000,
    blockTimeMs: 12_000,
    queueIteratorBlocksBatchSize: 8_000_000,
    queueLoaderRequestBlocksBatchSize: 8_000_000,
    queueLoaderStrategyName: 'rpc',
    basePreloadCount: 10,
    tracesEnabled: false,
  };

  beforeEach(() => {
    mockIterator = {
      startQueueIterating: jest.fn().mockResolvedValue(undefined),
      resolveNextBatch: jest.fn(),
    };

    mockLoader = {
      startBlocksLoading: jest.fn().mockResolvedValue(undefined),
    };

    mockMempoolLoader = {
      refresh: jest.fn().mockResolvedValue(undefined),
    };

    mockQueue = {
      dequeue: jest.fn().mockResolvedValue(5),
      reorganize: jest.fn().mockResolvedValue(undefined),
      findBlocks: jest.fn().mockResolvedValue([]),
    };

    service = new BlocksQueueService(
      mockIterator as any,
      mockLoader as any,
      mockMempoolLoader as any,
      config as any
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('start()', () => {
    it('calls startBlocksLoading and startQueueIterating', async () => {
      await service.start(0);
      expect(mockLoader.startBlocksLoading).toHaveBeenCalledTimes(1);
      expect(mockIterator.startQueueIterating).toHaveBeenCalledTimes(1);
    });
  });

  describe('confirmProcessedBatch()', () => {
    it('calls dequeue, mempoolService.refresh, and resolveNextBatch in order', async () => {
      await service.start(0);
      const callOrder: string[] = [];

      (service['_queue'] as any) = {
        ...mockQueue,
        dequeue: jest.fn().mockImplementation(async () => { callOrder.push('dequeue'); return 5; }),
      };
      mockMempoolLoader.refresh.mockImplementation(async () => { callOrder.push('refresh'); });
      mockIterator.resolveNextBatch.mockImplementation(() => { callOrder.push('resolve'); });

      await service.confirmProcessedBatch(['0xhash1', '0xhash2']);

      expect(callOrder).toEqual(['dequeue', 'refresh', 'resolve']);
    });

    it('still calls resolveNextBatch even when dequeue throws (finally block)', async () => {
      await service.start(0);
      (service['_queue'] as any) = {
        ...mockQueue,
        dequeue: jest.fn().mockRejectedValue(new Error('dequeue failed')),
      };

      await service.confirmProcessedBatch(['0xhash']);
      expect(mockIterator.resolveNextBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('reorganizeBlocks()', () => {
    it('calls reorganize, mempoolService.refresh, and resolveNextBatch', async () => {
      await service.start(0);
      const callOrder: string[] = [];

      (service['_queue'] as any) = {
        ...mockQueue,
        reorganize: jest.fn().mockImplementation(async () => { callOrder.push('reorganize'); }),
      };
      mockMempoolLoader.refresh.mockImplementation(async () => { callOrder.push('refresh'); });
      mockIterator.resolveNextBatch.mockImplementation(() => { callOrder.push('resolve'); });

      await service.reorganizeBlocks(3);

      expect(callOrder).toEqual(['reorganize', 'refresh', 'resolve']);
    });

    it('still calls resolveNextBatch even when reorganize throws (finally block)', async () => {
      await service.start(0);
      (service['_queue'] as any) = {
        ...mockQueue,
        reorganize: jest.fn().mockRejectedValue(new Error('reorg failed')),
      };

      await service.reorganizeBlocks(3);
      expect(mockIterator.resolveNextBatch).toHaveBeenCalledTimes(1);
    });
  });
});
