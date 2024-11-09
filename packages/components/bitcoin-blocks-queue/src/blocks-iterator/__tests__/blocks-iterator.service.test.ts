import { Test, TestingModule } from '@nestjs/testing';
import { AppLogger } from '@easylayer/components/logger';
import { BlocksQueueIteratorService } from '../blocks-iterator.service';
import { BlocksQueue } from '../../blocks-queue';
import { Block, BlocksCommandExecutor } from '../../interfaces';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

class TestBlock implements Block {
  height: number;
  hash: string;
  tx: any[];
  size: number;

  constructor(height: number, tx: any[] = []) {
    this.height = height;
    this.hash = '';
    this.tx = tx;
    this.size = 0;
  }
}

describe('BlocksQueueIteratorService', () => {
  let service: BlocksQueueIteratorService;
  let mockLogger: AppLogger;
  let mockBlocksCommandExecutor: jest.Mocked<BlocksCommandExecutor>;
  let mockQueue: BlocksQueue<TestBlock>;

  beforeEach(async () => {
    mockLogger = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    } as any;

    mockBlocksCommandExecutor = {
      handleBatch: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockQueue = new BlocksQueue<TestBlock>(-1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: AppLogger,
          useValue: mockLogger,
        },
        {
          provide: 'BlocksCommandExecutor',
          useValue: mockBlocksCommandExecutor,
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (logger, executor) =>
            new BlocksQueueIteratorService(logger, executor, { queueIteratorBlocksBatchSize: 2 }),
          inject: [AppLogger, 'BlocksCommandExecutor'],
        },
      ],
    }).compile();

    service = module.get<BlocksQueueIteratorService>(BlocksQueueIteratorService);
    service['_queue'] = mockQueue;
  });

  describe('initBatchProcessedPromise', () => {
    it('should create a promise and resolve it immediately if queue is empty', () => {
      service['initBatchProcessedPromise']();
      expect(service['batchProcessedPromise']).toBeInstanceOf(Promise);
      expect(service['resolveNextBatch']).toBeInstanceOf(Function);
    });

    it('should create a promise that can be resolved externally', async () => {
      const blockMock = new TestBlock(0, [{ hex: 'qq' }]);
      await mockQueue.enqueue(blockMock);

      service['initBatchProcessedPromise']();

      let resolved = false;
      service['batchProcessedPromise'].then(() => {
        resolved = true;
      });

      service['resolveNextBatch']();
      await service['batchProcessedPromise'];
      expect(resolved).toBe(true);
    });
  });

  describe('processBatch', () => {
    it('should call blocksCommandExecutor.handleBatch with correct arguments', async () => {
      const blockMock = new TestBlock(0);
      await service['processBatch']([blockMock]);

      expect(mockBlocksCommandExecutor.handleBatch).toHaveBeenCalledWith({
        batch: [blockMock],
        requestId: 'mock-uuid',
      });
    });

    it('should log an error if blocksCommandExecutor.handleBatch throws an error', async () => {
      const blockMock = new TestBlock(0);
      mockBlocksCommandExecutor.handleBatch.mockRejectedValueOnce(new Error('Test Error'));
      service['initBatchProcessedPromise']();
      await service['processBatch']([blockMock]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to process the batch',
        new Error('Test Error'),
        'BlocksQueueIteratorService'
      );
    });
  });

  describe('resolveNextBatch', () => {
    it('should return the resolveNextBatch function', () => {
      service['initBatchProcessedPromise']();
      const resolveFunction = service.resolveNextBatch;

      expect(typeof resolveFunction).toBe('function');
    });
  });
});
