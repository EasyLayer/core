import { BlockchainProviderService, Block } from '../../../../blockchain-provider';
import { PullRpcProviderStrategy } from '../pull-rpc-provider.strategy';
import { AppLogger } from '@easylayer/common/logger';
import { BlocksQueue } from '../../../blocks-queue';

function createTestBlock(height: number, hash: string, size: number): Block {
  return {
    height,
    hash,
    tx: [],
    size,
    strippedsize: size,
    sizeWithoutWitnesses: size,
    weight: size * 4,
    vsize: size,
    witnessSize: undefined,
    headerSize: 80,
    transactionsSize: size - 80,
    version: 1,
    versionHex: '00000001',
    merkleroot: '0'.repeat(64),
    time: Date.now(),
    mediantime: Date.now(),
    nonce: 0,
    bits: '0'.repeat(8),
    difficulty: '1',
    chainwork: '0'.repeat(64),
    nTx: 0
  };
}

describe('PullRpcProviderStrategy', () => {
  let strategy: PullRpcProviderStrategy;
  let mockLogger: jest.Mocked<AppLogger>;
  let mockProvider: jest.Mocked<BlockchainProviderService>;
  let queue: BlocksQueue<Block>;
  const basePreloadCount = 4;
  const defaultBlockSize = 1000;
  const maxRequestBlocksBatchSize = 5000;

  beforeEach(() => {
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: defaultBlockSize,
      maxQueueSize: 10 * 1024 * 1024
    });

    queue.isQueueOverloaded = jest.fn().mockReturnValue(false);

    mockLogger = { 
      debug: jest.fn(), 
      info: jest.fn(), 
      warn: jest.fn(), 
      error: jest.fn() 
    } as any;

    mockProvider = {
      getManyBlocksStatsByHeights: jest.fn(),
      getManyBlocksByHeights: jest.fn(),
    } as any;

    strategy = new PullRpcProviderStrategy(
      mockLogger,
      mockProvider,
      queue,
      { maxRequestBlocksBatchSize, basePreloadCount }
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('load()', () => {
    it('should throw when max height is reached', async () => {
      queue.maxBlockHeight = 100;
      (queue as any)._lastHeight = 101;
      
      await expect(strategy.load(200)).rejects.toThrow('Reached max block height');
    });

    it('should return early when queue is overloaded after preload', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 100, height: 1 }
      ]);
      queue.isQueueOverloaded = jest.fn().mockReturnValue(true);

      await strategy.load(5);
      
      expect(mockLogger.debug).toHaveBeenCalledWith('The queue is overloaded');
      expect(mockProvider.getManyBlocksByHeights).not.toHaveBeenCalled();
    });

    it('should successfully load and enqueue blocks', async () => {
      (queue as any)._lastHeight = 0;
      
      // Mock preload response
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 },
        { blockhash: 'hash2', total_size: 1500, height: 2 }
      ]);
      
      // Mock block loading response
      mockProvider.getManyBlocksByHeights.mockResolvedValue([
        createTestBlock(1, 'hash1', 1000),
        createTestBlock(2, 'hash2', 1500)
      ]);

      await strategy.load(10);
      
      expect(mockProvider.getManyBlocksStatsByHeights).toHaveBeenCalledWith([1, 2, 3, 4]);
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledWith([1, 2], true, undefined, true);
      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(2);
    });

    it('should not preload if items already exist in queue', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'existing', size: 1000, height: 1 }
      ];
      
      mockProvider.getManyBlocksByHeights.mockResolvedValue([
        createTestBlock(1, 'existing', 1000)
      ]);

      await strategy.load(10);
      
      expect(mockProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalled();
    });
  });

  describe('preloadBlocksInfo()', () => {
    it('should increase maxPreloadCount when timing ratio > 1.2', async () => {
      (strategy as any)._lastLoadAndEnqueueDuration = 1200;
      (strategy as any)._previousLoadAndEnqueueDuration = 1000;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 }
      ]);
      
      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(1); // Will process 1 block and adjust timing
      
      expect((strategy as any)._maxPreloadCount).toBe(Math.round(before * 1.25) - 1);
    });

    it('should decrease maxPreloadCount when timing ratio < 0.8', async () => {
      (strategy as any)._lastLoadAndEnqueueDuration = 700;
      (strategy as any)._previousLoadAndEnqueueDuration = 1000;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 }
      ]);
      
      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(1); // Will process 1 block and adjust timing
      
      expect((strategy as any)._maxPreloadCount).toBe(Math.max(1, Math.round(before * 0.75)));
    });

    it('should not change maxPreloadCount when timing is stable', async () => {
      (strategy as any)._lastLoadAndEnqueueDuration = 1000;
      (strategy as any)._previousLoadAndEnqueueDuration = 1000;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 }
      ]);
      
      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(1); // Will process 1 block and adjust timing
      
      expect((strategy as any)._maxPreloadCount).toBe(before);
    });

    it('should use total_size when available', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 2500, height: 1 }
      ]);
      
      await (strategy as any).preloadBlocksInfo(1);
      
      const preloadedItems = (strategy as any)._preloadedItemsQueue;
      expect(preloadedItems).toHaveLength(1);
      expect(preloadedItems[0]).toEqual({
        hash: 'hash1',
        size: 2500,
        height: 1
      });
    });

    it('should use default blockSize when total_size is null', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: null, height: 1 } as any
      ]);
      
      await (strategy as any).preloadBlocksInfo(1);
      
      const preloadedItems = (strategy as any)._preloadedItemsQueue;
      expect(preloadedItems[0].size).toBe(defaultBlockSize);
    });

    it('should throw when blockhash is missing', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: null, total_size: 1000, height: 1 }
      ] as any);
      
      await expect((strategy as any).preloadBlocksInfo(1))
        .rejects.toThrow('Block infos missing required hash and height');
    });

    it('should throw when height is missing', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: null }
      ] as any);
      
      await expect((strategy as any).preloadBlocksInfo(1))
        .rejects.toThrow('Block infos missing required hash and height');
    });

    it('should return early when no blocks to preload', async () => {
      (queue as any)._lastHeight = 10;
      const spy = jest.spyOn(mockProvider, 'getManyBlocksStatsByHeights');
      
      await (strategy as any).preloadBlocksInfo(10); // currentNetworkHeight = lastHeight
      
      expect(spy).not.toHaveBeenCalled();
    });

    it('should limit request count to maxPreloadCount', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._maxPreloadCount = 2;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 1000, height: 1 },
        { blockhash: 'h2', total_size: 1000, height: 2 }
      ]);
      
      await (strategy as any).preloadBlocksInfo(10); // Would request 10, limited to 2
      
      expect(mockProvider.getManyBlocksStatsByHeights).toHaveBeenCalledWith([1, 2]);
    });
  });

  describe('loadBlocks() - Retry Logic', () => {
    const infos = [
      { hash: 'hash1', size: 1000, height: 1 },
      { hash: 'hash2', size: 1500, height: 2 }
    ];

    it('should fetch blocks successfully on first try', async () => {
      const blocks = [
        createTestBlock(1, 'hash1', 1000),
        createTestBlock(2, 'hash2', 1500)
      ];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);
      
      const result = await (strategy as any).loadBlocks(infos, 3);
      
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledWith([1, 2], true, undefined, true);
      expect(result).toEqual(blocks);
    });

    it('should retry on failure and eventually succeed', async () => {
      const blocks = [createTestBlock(1, 'hash1', 1000)];
      mockProvider.getManyBlocksByHeights
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue(blocks);
      
      const result = await (strategy as any).loadBlocks(infos, 3);
      
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledTimes(2);
      expect(result).toEqual(blocks);
    });

    it('should throw after max retries', async () => {
      mockProvider.getManyBlocksByHeights.mockRejectedValue(new Error('Persistent error'));
      
      await expect((strategy as any).loadBlocks(infos, 2))
        .rejects.toThrow('Persistent error');
      
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Exceeded max retries for fetching blocks batch.',
        expect.objectContaining({
          methodName: 'loadBlocks',
          args: { batchLength: 2 }
        })
      );
    });
  });

  describe('enqueueBlocks() - Block Processing', () => {
    it('should enqueue blocks in ascending height order', async () => {
      // Start with lastHeight = 0 to allow enqueuing blocks 1, 2, 3
      (queue as any)._lastHeight = 0;
      
      const blocks = [
        createTestBlock(3, 'hash3', 1000),
        createTestBlock(1, 'hash1', 1000),
        createTestBlock(2, 'hash2', 1000)
      ];
      
      await (strategy as any).enqueueBlocks(blocks);
      
      expect(queue.length).toBe(3);
      expect(queue.lastHeight).toBe(3);
    });

    it('should skip blocks with height <= lastHeight', async () => {
      (queue as any)._lastHeight = 2;
      const blocks = [
        createTestBlock(1, 'hash1', 1000), // Should be skipped
        createTestBlock(2, 'hash2', 1000), // Should be skipped  
        createTestBlock(3, 'hash3', 1000)  // Should be enqueued
      ];
      
      await (strategy as any).enqueueBlocks(blocks);
      
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(3);
      expect(mockLogger.debug).toHaveBeenCalledTimes(2);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping block with height less than or equal to lastHeight',
        expect.objectContaining({
          args: expect.objectContaining({
            blockHeight: 1,
            lastHeight: 2
          })
        })
      );
    });
  });

  describe('loadAndEnqueueBlocks() - Integration', () => {
    it('should process and enqueue blocks successfully', async () => {
      // Start with lastHeight = 0 to allow enqueuing blocks 1, 2
      (queue as any)._lastHeight = 0;
      
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 1000, height: 1 },
        { hash: 'hash2', size: 1000, height: 2 }
      ];
      
      const blocks = [
        createTestBlock(1, 'hash1', 1000),
        createTestBlock(2, 'hash2', 1000)
      ];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);
      
      await (strategy as any).loadAndEnqueueBlocks();
      
      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(2);
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalled();
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });

    it('should keep unprocessed blocks in queue when batch size limit is exceeded', async () => {
      // Start with lastHeight = 0 to allow enqueuing blocks 1, 2
      (queue as any)._lastHeight = 0;
      
      // Create blocks where the third one won't fit in batch (maxRequestBlocksBatchSize = 5000)
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 2000, height: 1 },
        { hash: 'hash2', size: 2000, height: 2 },
        { hash: 'hash3', size: 2000, height: 3 } // This won't fit: 2000+2000+2000=6000 > 5000
      ];
      
      // Only blocks 1 and 2 will be processed
      const blocks = [
        createTestBlock(1, 'hash1', 2000),
        createTestBlock(2, 'hash2', 2000)
      ];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);
      
      await (strategy as any).loadAndEnqueueBlocks();
      
      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(2);
      // The third block should remain in the preloaded queue
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(1);
      expect((strategy as any)._preloadedItemsQueue[0]).toEqual({
        hash: 'hash3', 
        size: 2000, 
        height: 3
      });
    });
  });

  describe('stop()', () => {
    it('should clear preloaded items queue', async () => {
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 1000, height: 1 },
        { hash: 'hash2', size: 1000, height: 2 }
      ];
      
      await strategy.stop();
      
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });
  });
});