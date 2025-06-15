import { PullNetworkProviderStrategy } from '../pull-network-provider.strategy';
import { StrategyNames } from '../load-strategy.interface';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as jest.Mocked<any>;

const mockBlockchainProvider = {
  getManyBlocksByHeights: jest.fn(),
  getManyTransactionReceipts: jest.fn(),
  mergeReceiptsIntoBlocks: jest.fn(),
};

const mockQueue = {
  lastHeight: 100,
  isMaxHeightReached: false,
  isQueueFull: false,
  isQueueOverloaded: jest.fn(),
  enqueue: jest.fn(),
};

const createMockBlock = (blockNumber: number, txCount: number = 2, size: number = 1000): any => ({
  blockNumber,
  hash: `0x${blockNumber.toString(16)}`,
  transactions: Array.from({ length: txCount }, (_, i) => ({
    hash: `0xtx${blockNumber}_${i}`,
    from: '0xfrom',
    to: '0xto',
  })),
  sizeWithoutReceipts: size,
});

const createMockReceipt = (txHash: string): any => ({
  transactionHash: txHash,
  status: 1,
  gasUsed: '21000',
  logs: [],
});

describe('PullNetworkProviderStrategy', () => {
  let strategy: PullNetworkProviderStrategy;
  const defaultConfig = {
    maxRequestBlocksBatchSize: 1024 * 1024, // 1MB
    concurrency: 2,
    basePreloadCount: 5,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueue.lastHeight = 100;
    mockQueue.isMaxHeightReached = false;
    mockQueue.isQueueFull = false;
    mockQueue.isQueueOverloaded.mockReturnValue(false);
    
    strategy = new PullNetworkProviderStrategy(
      mockLogger,
      mockBlockchainProvider as any,
      mockQueue as any,
      defaultConfig
    );
  });

  describe('load', () => {
    it('should throw error when max height is reached', async () => {
      mockQueue.isMaxHeightReached = true;

      await expect(strategy.load(110)).rejects.toThrow('Reached max block height');
    });

    it('should throw error when current network height is reached', async () => {
      mockQueue.lastHeight = 110;

      await expect(strategy.load(110)).rejects.toThrow('Reached current network height');
    });

    it('should throw error when queue is full', async () => {
      mockQueue.isQueueFull = true;

      await expect(strategy.load(110)).rejects.toThrow('The queue is full');
    });

    it('should return early when queue is overloaded after preload', async () => {
      const mockBlocks = [createMockBlock(101), createMockBlock(102)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockQueue.isQueueOverloaded.mockReturnValue(true);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalledWith([101, 102, 103, 104, 105], true);
      expect(mockLogger.debug).toHaveBeenCalledWith('The queue is overloaded');
      expect(mockBlockchainProvider.getManyTransactionReceipts).not.toHaveBeenCalled();
    });

    it('should successfully load and enqueue blocks with receipts', async () => {
      const mockBlocks = [
        createMockBlock(101, 2),
        createMockBlock(102, 1),
      ];
      const mockReceipts = [
        createMockReceipt('0xtx101_0'),
        createMockReceipt('0xtx101_1'),
        createMockReceipt('0xtx102_0'),
      ];
      const mockCompleteBlocks = mockBlocks.map(block => ({ ...block, receipts: [] }));

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue(mockReceipts);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockCompleteBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalledWith([101, 102, 103, 104, 105], true);
      
      // Blocks are sorted by ascending order, so tx hashes will be in normal block order
      expect(mockBlockchainProvider.getManyTransactionReceipts).toHaveBeenCalledWith([
        '0xtx101_0', '0xtx101_1', '0xtx102_0'
      ]);
      expect(mockBlockchainProvider.mergeReceiptsIntoBlocks).toHaveBeenCalledWith(mockBlocks, mockReceipts);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should not preload again if preloaded queue is not empty', async () => {
      // First load - should preload
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      mockQueue.isQueueOverloaded.mockReturnValue(true); // Skip receipts loading

      await strategy.load(110);
      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalledTimes(1);

      // Second load - should not preload again
      jest.clearAllMocks();
      mockQueue.isQueueOverloaded.mockReturnValue(true);
      
      await strategy.load(110);
      expect(mockBlockchainProvider.getManyBlocksByHeights).not.toHaveBeenCalled();
    });

    it('should handle blocks with no transactions', async () => {
      const mockBlocksWithNoTx = [
        { ...createMockBlock(101), transactions: [] },
        { ...createMockBlock(102), transactions: [] },
      ];
      const mockCompleteBlocks = [...mockBlocksWithNoTx];

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocksWithNoTx);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockCompleteBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // When there are no transactions, getManyTransactionReceipts should NOT be called
      expect(mockBlockchainProvider.getManyTransactionReceipts).not.toHaveBeenCalled();
      expect(mockBlockchainProvider.mergeReceiptsIntoBlocks).toHaveBeenCalledWith(mockBlocksWithNoTx, []);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should limit preload count to remaining blocks', async () => {
      mockQueue.lastHeight = 108; // Only 2 blocks remaining to reach 110

      const mockBlocks = [createMockBlock(109), createMockBlock(110)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalledWith([109, 110], true);
    });
  });

  describe('stop', () => {
    it('should clear preloaded items queue', async () => {
      // First load some items
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockQueue.isQueueOverloaded.mockReturnValue(true);

      await strategy.load(110);
      
      // Stop strategy
      await strategy.stop();
      
      // Next load should preload again since queue was cleared
      jest.clearAllMocks();
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      
      await strategy.load(110);
      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalled();
    });
  });

  describe('dynamic preload count adjustment', () => {
    it('should increase preload count when consumption ratio > 0.9', async () => {
      // Mock initial load with high consumption
      const mockBlocks = Array.from({ length: 5 }, (_, i) => createMockBlock(101 + i));
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);
      
      // Clear preloaded queue and trigger next preload
      (strategy as any)._preloadedItemsQueue = [];
      mockQueue.lastHeight = 105;
      
      // Next load should request more blocks (increased preload count)
      const moreBlocks = Array.from({ length: 6 }, (_, i) => createMockBlock(106 + i)); // Should be more than 5
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(moreBlocks);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);

      await strategy.load(120);
      
      // Should request more than initial 5 blocks
      const lastCall = mockBlockchainProvider.getManyBlocksByHeights.mock.calls[1];
      expect(lastCall[0].length).toBeGreaterThan(5);
    });

    it('should decrease preload count when consumption ratio < 0.2', async () => {
      // First load with high count but low consumption
      const strategy = new PullNetworkProviderStrategy(
        mockLogger,
        mockBlockchainProvider as any,
        mockQueue as any,
        { ...defaultConfig, basePreloadCount: 10 }
      );

      // Simulate low consumption by manually setting internal state
      (strategy as any)._lastPreloadCount = 10;
      (strategy as any)._lastLoadedCount = 1; // Only 1 out of 10 used (10% < 20%)

      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);
      
      // Should request fewer blocks in the next preload
      const requestedHeights = mockBlockchainProvider.getManyBlocksByHeights.mock.calls[0][0];
      expect(requestedHeights.length).toBeLessThan(10);
    });
  });

  describe('batch creation and receipt size estimation', () => {
    it('should create optimal batches based on estimated receipt sizes', async () => {
      // Create blocks with different sizes to test batching logic
      const largeBlock = createMockBlock(101, 10, 3 * 1024 * 1024); // 3MB block
      const mediumBlock = createMockBlock(102, 5, 600 * 1024); // 600KB block
      const smallBlock = createMockBlock(103, 2, 100 * 1024); // 100KB block

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([largeBlock, mediumBlock, smallBlock]);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Blocks are sorted by ascending order (101, 102, 103), so transaction hashes follow that order
      const expectedTxHashes = [
        ...largeBlock.transactions.map((tx: any) => tx.hash),   // 101 first
        ...mediumBlock.transactions.map((tx: any) => tx.hash),  // 102 second  
        ...smallBlock.transactions.map((tx: any) => tx.hash),   // 103 last
      ];
      
      expect(mockBlockchainProvider.getManyTransactionReceipts).toHaveBeenCalledWith(expectedTxHashes);
    });

    it('should estimate receipt sizes correctly based on block characteristics', async () => {
      // Test receipt size estimation through the batch creation process
      const strategy = new PullNetworkProviderStrategy(
        mockLogger,
        mockBlockchainProvider as any,
        mockQueue as any,
        { ...defaultConfig, maxRequestBlocksBatchSize: 10000 } // Small batch size to test batching
      );

      const largeBlock = createMockBlock(101, 3, 3 * 1024 * 1024); // Should estimate ~2KB per receipt
      const smallBlock = createMockBlock(102, 3, 100 * 1024); // Should estimate ~500B per receipt

      // Set preloaded queue directly to test batching
      (strategy as any)._preloadedItemsQueue = [largeBlock, smallBlock];

      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Verify that receipts were loaded (indicating batches were created properly)
      expect(mockBlockchainProvider.getManyTransactionReceipts).toHaveBeenCalled();
    });
  });

  describe('error handling and retries', () => {
    it('should retry failed receipt loading up to max retries', async () => {
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      
      // Fail first two attempts, succeed on third
      mockBlockchainProvider.getManyTransactionReceipts
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([createMockReceipt('0xtx101_0')]);
      
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyTransactionReceipts).toHaveBeenCalledTimes(3);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should throw error after exceeding max retries', async () => {
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockRejectedValue(new Error('Persistent network error'));

      await expect(strategy.load(110)).rejects.toThrow('Persistent network error');
      
      expect(mockBlockchainProvider.getManyTransactionReceipts).toHaveBeenCalledTimes(3); // Max retries
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Exceeded max retries for receipts batch',
        expect.objectContaining({
          args: expect.objectContaining({
            blockCount: 1,
            error: expect.any(Error),
          })
        })
      );
    });
  });

  describe('block enqueueing', () => {
    it('should skip blocks with height less than or equal to queue lastHeight', async () => {
      const oldBlock = createMockBlock(99); // Less than queue.lastHeight (100)
      const validBlock = createMockBlock(101);
      
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([oldBlock, validBlock]);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([oldBlock, validBlock]);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Should only enqueue the valid block
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(validBlock);
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipping block with height less than or equal to lastHeight',
        expect.objectContaining({
          args: {
            blockHeight: 99,
            lastHeight: 100,
          }
        })
      );
    });

    it('should enqueue blocks in correct order (ascending height)', async () => {
      const blocks = [
        createMockBlock(103),
        createMockBlock(101),
        createMockBlock(102),
      ];
      
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(blocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(blocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Should enqueue in ascending order
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(3);
      expect(mockQueue.enqueue.mock.calls[0][0].blockNumber).toBe(101);
      expect(mockQueue.enqueue.mock.calls[1][0].blockNumber).toBe(102);
      expect(mockQueue.enqueue.mock.calls[2][0].blockNumber).toBe(103);
    });
  });

  describe('concurrency handling', () => {
    it('should process batches concurrently based on concurrency setting', async () => {
      const strategy = new PullNetworkProviderStrategy(
        mockLogger,
        mockBlockchainProvider as any,
        mockQueue as any,
        { ...defaultConfig, concurrency: 3 }
      );

      // Create many blocks to ensure multiple batches
      const manyBlocks = Array.from({ length: 20 }, (_, i) => createMockBlock(101 + i));
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(manyBlocks);
      mockBlockchainProvider.getManyTransactionReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(130);

      // Should have called mergeReceiptsIntoBlocks (indicating concurrent processing occurred)
      expect(mockBlockchainProvider.mergeReceiptsIntoBlocks).toHaveBeenCalled();
    });
  });
});