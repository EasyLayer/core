import { Test, TestingModule } from '@nestjs/testing';
import { AppLogger } from '@easylayer/components/logger';
import { BlocksQueueService } from '../blocks-queue.service';
import { BlocksQueue } from '../blocks-queue';
import { Block } from '../interfaces';
import { BlocksQueueIteratorService } from '../blocks-iterator';
import { BlocksQueueLoaderService } from '../blocks-loader';

describe('BlocksQueueService', () => {
  let service: BlocksQueueService;
  let mockLogger: jest.Mocked<AppLogger>;
  let mockBlocksIterator: jest.Mocked<BlocksQueueIteratorService>;
  let mockBlocksLoader: jest.Mocked<BlocksQueueLoaderService>;
  let mockBlockQueue: jest.Mocked<BlocksQueue<Block>>;
  let config: { maxQueueLength: number; maxBlockHeight: number };

  beforeEach(async () => {
    mockLogger = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    } as any;

    mockBlocksIterator = {
      startQueueIterating: jest.fn(),
      resolveNextBatch: jest.fn(),
    } as any;

    mockBlocksLoader = {
      startBlocksLoading: jest.fn(),
    } as any;

    // Initialize the mockBlockQueue without directly assigning to read-only properties
    mockBlockQueue = {
      enqueue: jest.fn(),
      dequeue: jest.fn(),
      reorganize: jest.fn(),
      findBlocks: jest.fn(),
      inStack: [],
      outStack: [],
      length: 0,
      maxQueueLength: 0,
      maxBlockHeight: 0,
    } as any;

    config = { maxQueueLength: 1000, maxBlockHeight: 1000000 };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: AppLogger, useValue: mockLogger },
        { provide: BlocksQueueIteratorService, useValue: mockBlocksIterator },
        { provide: BlocksQueueLoaderService, useValue: mockBlocksLoader },
        { provide: 'CONFIG', useValue: config },
        {
          provide: BlocksQueueService,
          useFactory: (
            logger: AppLogger,
            iterator: BlocksQueueIteratorService,
            loader: BlocksQueueLoaderService,
            config: any
          ) => new BlocksQueueService(logger, iterator, loader, config),
          inject: [AppLogger, BlocksQueueIteratorService, BlocksQueueLoaderService, 'CONFIG'],
        },
      ],
    }).compile();

    service = module.get<BlocksQueueService>(BlocksQueueService);

    // Assign the mocked block queue to the service
    service['_queue'] = mockBlockQueue;
  });

  describe('start', () => {
    it('should initialize and start loading and iterating', () => {
      const indexedHeight = 100;
      service['initQueue'] = jest.fn(); // Mock the init method

      service.start(indexedHeight);

      expect(service['initQueue']).toHaveBeenCalledWith(indexedHeight);
      expect(mockBlocksLoader.startBlocksLoading).toHaveBeenCalledWith(mockBlockQueue);
      expect(mockBlocksIterator.startQueueIterating).toHaveBeenCalledWith(mockBlockQueue);
    });
  });

  describe('reorganizeBlocks', () => {
    it('should reorganize the queue and resolve the next batch', async () => {
      mockBlockQueue.reorganize = jest.fn();
      const newStartHeight = 200;

      await service.reorganizeBlocks(newStartHeight);

      expect(mockBlockQueue.reorganize).toHaveBeenCalledWith(Number(newStartHeight));
      expect(mockBlocksIterator.resolveNextBatch).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue was clear to height: ',
        { newStartHeight },
        service.constructor.name
      );
    });
  });

  describe('queue', () => {
    it('should return the block queue', () => {
      expect(service.queue).toBe(mockBlockQueue);
    });
  });
});
