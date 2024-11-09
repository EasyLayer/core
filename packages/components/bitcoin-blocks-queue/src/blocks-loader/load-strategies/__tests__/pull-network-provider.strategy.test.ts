import { NetworkProviderService } from '@easylayer/components/bitcoin-network-provider';
import { AppLogger } from '@easylayer/components/logger';
import { PullNetworkProviderStrategy } from '../pull-network-provider.strategy';
import { BlocksQueue } from '../../../blocks-queue';
import { Block } from '../../../interfaces';

describe('PullNetworkProviderStrategy', () => {
  let strategy: PullNetworkProviderStrategy;
  let mockLogger: jest.Mocked<AppLogger>;
  let mockNetworkProvider: jest.Mocked<NetworkProviderService>;
  let mockQueue: jest.Mocked<BlocksQueue<Block>>;
  let config: { maxRequestBlocksBatchSize: number; isTest: boolean; concurrency: number };

  beforeEach(() => {
    // Initialize mock logger with jest.fn() for all methods
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    // Initialize mock network provider with jest.fn() for necessary methods
    mockNetworkProvider = {
      getManyBlocksByHeights: jest.fn(),
      getManyBlocksStatsByHeights: jest.fn(),
      getManyBlocksByHashes: jest.fn(),
    } as any;

    // Initialize mock queue with necessary methods
    mockQueue = {
      enqueue: jest.fn(),
      isQueueOverloaded: jest.fn(),
    } as any;

    config = { maxRequestBlocksBatchSize: 10 * 1024 * 1024, isTest: true, concurrency: 1 }; // 10 MB

    // Instantiate the strategy with mocked dependencies
    strategy = new PullNetworkProviderStrategy(mockLogger, mockNetworkProvider, mockQueue, config);
  });

  afterEach(() => {
    // Clear all mock calls and instances after each test to ensure isolation
    jest.clearAllMocks();
  });

  describe('load', () => {
    it('should log and return if the maximum block height is reached', async () => {
      const currentNetworkHeight = 100;

      // Mocking 'isMaxHeightReached' to return true
      Object.defineProperty(mockQueue, 'isMaxHeightReached', {
        get: () => true,
      });

      // Mocking 'lastHeight' to return 100
      Object.defineProperty(mockQueue, 'lastHeight', {
        get: () => 100,
      });

      await strategy.load(currentNetworkHeight);

      // Expect a debug log indicating the max block height is reached
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Reached max block height',
        { queueLastHeight: 100 },
        'PullNetworkProviderStrategy'
      );

      // Ensure no further actions are taken
      expect(mockNetworkProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should log and return if the current network height is reached', async () => {
      const currentNetworkHeight = 100;

      // Mocking 'isMaxHeightReached' to return false
      Object.defineProperty(mockQueue, 'isMaxHeightReached', {
        get: () => false,
      });

      // Mocking 'lastHeight' to return 100
      Object.defineProperty(mockQueue, 'lastHeight', {
        get: () => 100,
      });

      await strategy.load(currentNetworkHeight);

      // Expect a debug log indicating the current network height is reached
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Reached current network height',
        { queueLastHeight: 100 },
        'PullNetworkProviderStrategy'
      );

      // Ensure no further actions are taken
      expect(mockNetworkProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should log and return if the queue is full', async () => {
      const currentNetworkHeight = 150;

      // Mocking 'isMaxHeightReached' to return false
      Object.defineProperty(mockQueue, 'isMaxHeightReached', {
        get: () => false,
      });

      // Mocking 'lastHeight' to return 50
      Object.defineProperty(mockQueue, 'lastHeight', {
        get: () => 50,
      });

      // Mocking 'isQueueFull' to return true
      Object.defineProperty(mockQueue, 'isQueueFull', {
        get: () => true,
      });

      await strategy.load(currentNetworkHeight);

      // Expect a debug log indicating the queue is full
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'The queue is full',
        { queueLastHeight: 50 },
        'PullNetworkProviderStrategy'
      );

      // Ensure no further actions are taken
      expect(mockNetworkProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('should log and return if the queue is overloaded', async () => {
      const currentNetworkHeight = 20;

      // Mocking 'isMaxHeightReached' to return false
      Object.defineProperty(mockQueue, 'isMaxHeightReached', {
        get: () => false,
      });

      // Mocking 'lastHeight' to return 10
      Object.defineProperty(mockQueue, 'lastHeight', {
        get: () => 10,
      });

      // Mocking 'isQueueFull' to return false
      Object.defineProperty(mockQueue, 'isQueueFull', {
        get: () => false,
      });

      // Populate the preloaded queue with items
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 5 * 1024 * 1024, height: 11 },
        { hash: 'hash2', size: 5 * 1024 * 1024, height: 12 },
      ];

      // Mock 'isQueueOverloaded' to return true
      mockQueue.isQueueOverloaded.mockReturnValue(true);

      await strategy.load(currentNetworkHeight);

      // Expect a debug log indicating the queue is overloaded
      expect(mockLogger.debug).toHaveBeenCalledWith('The queue is overloaded', {}, 'PullNetworkProviderStrategy');

      // Ensure loadAndEnqueueBlocks is not called
      const loadAndEnqueueMock = jest.spyOn(strategy as any, 'loadAndEnqueueBlocks');
      expect(loadAndEnqueueMock).not.toHaveBeenCalled();

      loadAndEnqueueMock.mockRestore();
    });
  });

  describe('stop', () => {
    it('should clear the preloaded items queue', async () => {
      // Populate the preloaded queue with items
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 500, height: 1 },
        { hash: 'hash2', size: 600, height: 2 },
      ];

      await strategy.stop();

      // Expect the preloaded queue to be empty
      expect((strategy as any)._preloadedItemsQueue).toEqual([]);
    });
  });

  describe('preloadBlocksInfo', () => {
    it('should throw an error if block stats params are missing', async () => {
      const currentNetworkHeight = 5;

      // Mocking 'lastHeight' to return 0
      Object.defineProperty(mockQueue, 'lastHeight', {
        get: () => 0,
      });

      // Mocking 'isMaxHeightReached' to return false
      Object.defineProperty(mockQueue, 'isMaxHeightReached', {
        get: () => false,
      });

      // Mock blocks stats response with missing parameters
      mockNetworkProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: null, total_size: 500, height: 1 }, // Invalid blockhash
      ]);

      await expect((strategy as any).preloadBlocksInfo(currentNetworkHeight)).rejects.toThrow(
        'Block stats params is missed'
      );

      // Ensure the preloaded queue remains empty
      expect((strategy as any)._preloadedItemsQueue).toEqual([]);
    });

    it('should preload blocks correctly when all block stats params are present', async () => {
      const currentNetworkHeight = 3;

      (strategy as any).isTest = false;

      // Mocking 'lastHeight' to return 0
      Object.defineProperty(mockQueue, 'lastHeight', {
        get: () => 0,
      });

      // Mocking 'isMaxHeightReached' to return false
      Object.defineProperty(mockQueue, 'isMaxHeightReached', {
        get: () => false,
      });

      // Mock blocks stats response with missing parameters
      mockNetworkProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 500, height: 1 },
        { blockhash: 'hash2', total_size: 600, height: 2 },
        { blockhash: 'hash3', total_size: 700, height: 3 },
      ]);

      // Call the private method using type casting
      await (strategy as any).preloadBlocksInfo(currentNetworkHeight);

      // Verify that the items are added to the preloaded queue
      expect((strategy as any)._preloadedItemsQueue).toEqual([
        { hash: 'hash1', size: 500, height: 1 },
        { hash: 'hash2', size: 600, height: 2 },
        { hash: 'hash3', size: 700, height: 3 },
      ]);
    });
  });

  describe('loadAndEnqueueBlocks', () => {
    it('should load blocks and enqueue them successfully', async () => {
      // Set concurrency to 1 for simplicity
      config.concurrency = 1;
      strategy = new PullNetworkProviderStrategy(mockLogger, mockNetworkProvider, mockQueue, config);

      // Populate the preloaded queue with blocks
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 500, height: 1 },
        { hash: 'hash2', size: 600, height: 2 },
      ];

      // Mock loadBlocks to return fetched blocks
      const mockBlocks: Block[] = [
        { height: 1, hash: 'hash1', tx: [], size: 500 },
        { height: 2, hash: 'hash2', tx: [], size: 600 },
      ];
      const loadBlocksMock = jest.spyOn(strategy as any, 'loadBlocks').mockResolvedValue(mockBlocks);

      // Mock enqueueBlocks to enqueue the blocks
      // const enqueueBlocksMock = jest.spyOn(strategy as any, 'enqueueBlocks').mockResolvedValue();

      await (strategy as any).loadAndEnqueueBlocks();

      // Expect loadBlocks to be called with the correct hashes
      expect(loadBlocksMock).toHaveBeenCalledWith(['hash1', 'hash2'], 3);

      // Expect enqueueBlocks to be called with the fetched blocks
      // expect(enqueueBlocksMock).toHaveBeenCalledWith(mockBlocks);

      // Ensure the preloaded queue is emptied
      expect((strategy as any)._preloadedItemsQueue).toEqual([]);

      loadBlocksMock.mockRestore();
      // enqueueBlocksMock.mockRestore();
    });

    it('should handle loadBlocks throwing an error after retries', async () => {
      // Populate the preloaded queue with blocks
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 500, height: 1 },
        { hash: 'hash2', size: 600, height: 2 },
      ];

      // Mock loadBlocks to throw an error
      const loadBlocksMock = jest.spyOn(strategy as any, 'loadBlocks').mockRejectedValue(new Error('Network error'));

      // Mock enqueueBlocks to prevent actual enqueuing
      // const enqueueBlocksMock = jest.spyOn(strategy as any, 'enqueueBlocks').mockResolvedValue();

      // Expect loadAndEnqueueBlocks to throw the error
      await expect((strategy as any).loadAndEnqueueBlocks()).rejects.toThrow('Network error');

      // Ensure enqueueBlocks was not called
      // expect(enqueueBlocksMock).not.toHaveBeenCalled();

      loadBlocksMock.mockRestore();
      // enqueueBlocksMock.mockRestore();
    });
  });

  describe('loadBlocks', () => {
    it('should fetch blocks successfully on the first attempt', async () => {
      const hashBatch = ['hash1', 'hash2'];
      const maxRetries = 3;

      const fetchedBlocks: Block[] = [
        { height: 1, hash: 'hash1', tx: [], size: 500 },
        { height: 2, hash: 'hash2', tx: [], size: 600 },
      ];

      // Mock getManyBlocksByHashes to return fetched blocks
      mockNetworkProvider.getManyBlocksByHashes.mockResolvedValue(fetchedBlocks);

      const result = await (strategy as any).loadBlocks(hashBatch, maxRetries);

      // Expect getManyBlocksByHashes to be called with the correct parameters
      expect(mockNetworkProvider.getManyBlocksByHashes).toHaveBeenCalledWith(hashBatch, 2);

      // Expect the fetched blocks to be returned
      expect(result).toEqual(fetchedBlocks);
    });

    it('should retry fetching blocks up to maxRetries on failure', async () => {
      const hashBatch = ['hash1', 'hash2'];
      const maxRetries = 3;

      // Mock getManyBlocksByHashes to fail twice before succeeding
      mockNetworkProvider.getManyBlocksByHashes
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue([
          { height: 1, hash: 'hash1', tx: [], size: 500 },
          { height: 2, hash: 'hash2', tx: [], size: 600 },
        ]);

      const result = await (strategy as any).loadBlocks(hashBatch, maxRetries);

      // Expect getManyBlocksByHashes to be called three times
      expect(mockNetworkProvider.getManyBlocksByHashes).toHaveBeenCalledTimes(3);

      // Expect the fetched blocks to be returned after retries
      expect(result).toEqual([
        { height: 1, hash: 'hash1', tx: [], size: 500 },
        { height: 2, hash: 'hash2', tx: [], size: 600 },
      ]);
    });

    it('should throw an error after exceeding maxRetries', async () => {
      const hashBatch = ['hash1', 'hash2'];
      const maxRetries = 2;

      // Mock getManyBlocksByHashes to always fail
      mockNetworkProvider.getManyBlocksByHashes.mockRejectedValue(new Error('Network error'));

      // Spy on the logger to verify warning is logged
      const warnMock = jest.spyOn(mockLogger, 'warn');

      await expect((strategy as any).loadBlocks(hashBatch, maxRetries)).rejects.toThrow('Network error');

      // Expect getManyBlocksByHashes to be called maxRetries times
      expect(mockNetworkProvider.getManyBlocksByHashes).toHaveBeenCalledTimes(maxRetries);

      // Expect a warning to be logged after exceeding retries
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Exceeded max retries for fetching blocks batch.',
        { batchLength: 2 },
        'PullNetworkProviderStrategy'
      );

      warnMock.mockRestore();
    });
  });
});
