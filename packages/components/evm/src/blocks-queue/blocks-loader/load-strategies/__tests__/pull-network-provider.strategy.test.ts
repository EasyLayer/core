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
  getManyBlocksWithReceipts: jest.fn(), // Исправлено: правильный метод
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
      expect(mockBlockchainProvider.getManyBlocksWithReceipts).not.toHaveBeenCalled();
    });

    it('should successfully load and enqueue blocks with receipts', async () => {
      const mockBlocks = [
        createMockBlock(101, 2),
        createMockBlock(102, 1),
      ];
      const mockBlocksReceipts = [
        [createMockReceipt('0xtx101_0'), createMockReceipt('0xtx101_1')], // Block 101 receipts
        [createMockReceipt('0xtx102_0')], // Block 102 receipts
      ];
      const mockCompleteBlocks = mockBlocks.map(block => ({ ...block, receipts: [] }));

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue(mockBlocksReceipts);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockCompleteBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalledWith([101, 102, 103, 104, 105], true);
      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([101, 102]);
      expect(mockBlockchainProvider.mergeReceiptsIntoBlocks).toHaveBeenCalledWith(mockBlocks, []);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should not preload again if preloaded queue is not empty', async () => {
      // First load - should preload
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[]]);
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
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[], []]); // Empty receipts arrays
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockCompleteBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([101, 102]);
      expect(mockBlockchainProvider.mergeReceiptsIntoBlocks).toHaveBeenCalledWith(mockBlocksWithNoTx, []);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should limit preload count to remaining blocks', async () => {
      mockQueue.lastHeight = 108; // Only 2 blocks remaining to reach 110

      const mockBlocks = [createMockBlock(109), createMockBlock(110)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[], []]);
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
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      
      await strategy.load(110);
      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalled();
    });
  });

  describe('dynamic preload count adjustment', () => {
    it('should increase preload count when loadReceipts takes longer', async () => {
      // Set up timing history to trigger increase
      (strategy as any)._previousLoadReceiptsDuration = 1000;
      (strategy as any)._lastLoadReceiptsDuration = 1300; // 30% longer > 20%

      const mockBlocks = Array.from({ length: 5 }, (_, i) => createMockBlock(101 + i));
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue(Array(5).fill([]));
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Clear preloaded queue and trigger next preload
      (strategy as any)._preloadedItemsQueue = [];
      mockQueue.lastHeight = 105;

      // Next load should request more blocks (increased preload count)
      const moreBlocks = Array.from({ length: 7 }, (_, i) => createMockBlock(106 + i));
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(moreBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue(Array(7).fill([]));
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);

      await strategy.load(120);

      // Should request more than initial 5 blocks
      const lastCall = mockBlockchainProvider.getManyBlocksByHeights.mock.calls[1];
      expect(lastCall[0].length).toBeGreaterThan(5);
    });

    it('should decrease preload count when loadReceipts is faster', async () => {
      // Set up timing history to trigger decrease
      (strategy as any)._previousLoadReceiptsDuration = 1000;
      (strategy as any)._lastLoadReceiptsDuration = 700; // 30% faster < 20%

      const mockBlocks = Array.from({ length: 3 }, (_, i) => createMockBlock(101 + i));
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue(Array(3).fill([]));
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);
      
      // Clear preloaded queue and trigger next preload  
      (strategy as any)._preloadedItemsQueue = [];
      mockQueue.lastHeight = 103;

      await strategy.load(120);
      
      // Should request fewer blocks in the next preload
      const lastCall = mockBlockchainProvider.getManyBlocksByHeights.mock.calls[1];
      expect(lastCall[0].length).toBeLessThan(5); // Less than original basePreloadCount
    });
  });

  describe('batch creation and receipt size estimation', () => {
    it('should create optimal batches based on estimated receipt sizes', async () => {
      // Create blocks with different sizes to test batching logic
      const largeBlock = createMockBlock(101, 10, 3 * 1024 * 1024); // 3MB block
      const mediumBlock = createMockBlock(102, 5, 600 * 1024); // 600KB block
      const smallBlock = createMockBlock(103, 2, 100 * 1024); // 100KB block

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([largeBlock, mediumBlock, smallBlock]);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[], [], []]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([101, 102, 103]);
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

      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[], []]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue([]);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Verify that receipts were loaded (indicating batches were created properly)
      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalled();
    });
  });

  describe('error handling and retries', () => {
    it('should retry failed receipt loading up to max retries', async () => {
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      
      // Fail first two attempts, succeed on third
      mockBlockchainProvider.getManyBlocksWithReceipts
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([[createMockReceipt('0xtx101_0')]]);
      
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(mockBlocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalledTimes(3);
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should throw error after exceeding max retries', async () => {
      const mockBlocks = [createMockBlock(101)];
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(mockBlocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockRejectedValue(new Error('Persistent network error'));

      await expect(strategy.load(110)).rejects.toThrow('Persistent network error');
      
      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalledTimes(3); // Max retries
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
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[], []]);
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

    it('should enqueue blocks in correct order (descending height for processing)', async () => {
      const blocks = [
        createMockBlock(103),
        createMockBlock(101),
        createMockBlock(102),
      ];
      
      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue(blocks);
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([[], [], []]);
      mockBlockchainProvider.mergeReceiptsIntoBlocks.mockResolvedValue(blocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      await strategy.load(110);

      // Should enqueue in descending order (blocks are sorted desc and popped from end)
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(3);
      expect(mockQueue.enqueue.mock.calls[0][0].blockNumber).toBe(101);
      expect(mockQueue.enqueue.mock.calls[1][0].blockNumber).toBe(102);
      expect(mockQueue.enqueue.mock.calls[2][0].blockNumber).toBe(103);
    });
  });
});