import { Test, TestingModule } from '@nestjs/testing';
import { AppLogger } from '@easylayer/common/logger';
import { Block } from '../../../blockchain-provider';
import { BlocksQueueIteratorService } from '../blocks-iterator.service';
import { BlocksQueue } from '../../blocks-queue';
import { BlocksCommandExecutor } from '../../interfaces';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

class TestBlock implements Block {
  height: number;
  hash: string;
  tx: any[];
  size: number;
  confirmations: number = 0;
  strippedsize: number = 0;
  weight: number = 0;
  version: number = 1;
  versionHex: string = '00000001';
  merkleroot: string = '0'.repeat(64);
  time: number = Date.now();
  mediantime: number = Date.now();
  nonce: number = 0;
  bits: string = '0'.repeat(8);
  difficulty: string = '1';
  chainwork: string = '0'.repeat(64);

  constructor(height: number, tx: any[] = []) {
    this.height = height;
    this.hash = `hash${height}`;
    this.tx = tx;
    this.size = tx.reduce((acc, tx) => acc + (tx.hex?.length || 0) / 2, 0);
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
      warn: jest.fn(),
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
  });

  describe('resolveNextBatch', () => {
    it('should return the resolveNextBatch function', () => {
      service['initBatchProcessedPromise']();
      const resolveFunction = service.resolveNextBatch;

      expect(typeof resolveFunction).toBe('function');
    });
  });
});
