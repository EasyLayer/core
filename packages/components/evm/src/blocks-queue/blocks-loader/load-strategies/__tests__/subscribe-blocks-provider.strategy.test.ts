import { SubscribeBlocksProviderStrategy } from '../subscribe-blocks-provider.strategy';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as jest.Mocked<any>;

const mockBlockchainProvider = {
  subscribeToNewBlocks: jest.fn(),
  getManyBlocksWithReceipts: jest.fn(), // Fixed method name
};

const mockQueue = {
  lastHeight: 100,
  isMaxHeightReached: false,
  isQueueFull: false,
  enqueue: jest.fn(),
};

const mockBlock = {
  blockNumber: 101,
  hash: '0x123',
  transactions: [],
};

describe('SubscribeBlocksProviderStrategy', () => {
  let strategy: SubscribeBlocksProviderStrategy;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQueue.lastHeight = 100;
    mockQueue.isMaxHeightReached = false;
    mockQueue.isQueueFull = false;
    
    strategy = new SubscribeBlocksProviderStrategy(
      mockLogger,
      mockBlockchainProvider as any,
      mockQueue as any,
      {}
    );
  });

  describe('load', () => {
    it('should perform initial catchup and setup subscription', async () => {
      let resolveSubscription: () => void;
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        resolveSubscription();
      });

      // Mock blocks for catch-up (101 and 102)
      const catchupBlocks = [
        { blockNumber: 101, hash: '0x101', transactions: [] },
        { blockNumber: 102, hash: '0x102', transactions: [] }
      ];
      
      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue(catchupBlocks);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);
      mockQueue.enqueue.mockResolvedValue(undefined);

      const loadPromise = strategy.load(102);

      // Wait for subscription setup
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate receiving new block through subscription
      const subscriptionCallback = mockBlockchainProvider.subscribeToNewBlocks.mock.calls[0][0];
      const newBlock = { blockNumber: 103, hash: '0x103', transactions: [] };
      await subscriptionCallback(newBlock);

      // Complete subscription
      mockSubscription.unsubscribe();
      
      await loadPromise;

      // Check that catch-up was performed for blocks 101 and 102
      expect(mockBlockchainProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([101, 102], true);
      
      // Check that all blocks were added to queue (catchup + new block)
      // The actual order depends on the sorting logic in enqueueBlocks method
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(3); // 2 blocks from catch-up + 1 new
      
      // Check that specific blocks were enqueued (order might be different due to sorting)
      const enqueuedBlocks = mockQueue.enqueue.mock.calls.map(call => call[0]);
      expect(enqueuedBlocks).toContainEqual(expect.objectContaining({ blockNumber: 101 }));
      expect(enqueuedBlocks).toContainEqual(expect.objectContaining({ blockNumber: 102 }));
      expect(enqueuedBlocks).toContainEqual(expect.objectContaining({ blockNumber: 103 }));
      
      expect(mockBlockchainProvider.subscribeToNewBlocks).toHaveBeenCalled();
    });

    it('should skip blocks with height less than or equal to queue lastHeight', async () => {
      let resolveSubscription: () => void;
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        resolveSubscription();
      });

      const oldBlock = { ...mockBlock, blockNumber: 99 }; // Lower than queue.lastHeight (100)

      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      const loadPromise = strategy.load(102);

      // Wait for subscription setup
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simulate subscription callback with old block
      const subscriptionCallback = mockBlockchainProvider.subscribeToNewBlocks.mock.calls[0][0];
      await subscriptionCallback(oldBlock);

      // Complete subscription
      mockSubscription.unsubscribe();
      
      await loadPromise;

      // Check that old block was not added to queue
      // enqueue might have been called for catch-up blocks, but not for the old block
      const enqueueCalls = mockQueue.enqueue.mock.calls;
      const oldBlockEnqueued = enqueueCalls.some(call => call[0].blockNumber === 99);
      expect(oldBlockEnqueued).toBe(false);
      
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

    it('should not create duplicate subscriptions', async () => {
      let resolveSubscription: () => void;
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        resolveSubscription();
      });

      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      // First call - creates subscription
      const firstLoadPromise = strategy.load(102);
      
      // Wait for subscription setup
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Second call should return immediately without creating new subscription
      await strategy.load(102);

      expect(mockBlockchainProvider.subscribeToNewBlocks).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith('Already subscribed to new blocks');
      
      // Complete first subscription
      mockSubscription.unsubscribe();
      await firstLoadPromise;
    });
  });

  describe('stop', () => {
    it('should unsubscribe from active subscription', async () => {
      let resolveSubscription: () => void;
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        resolveSubscription();
      });

      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      // Start subscription
      const loadPromise = strategy.load(102);
      
      // Wait for subscription setup
      await new Promise(resolve => setTimeout(resolve, 50));

      // Stop subscription
      await strategy.stop();
      await loadPromise; // Wait for load to complete

      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Unsubscribed from new blocks');
    });

    it('should handle stop when no active subscription exists', async () => {
      await strategy.stop();

      expect(mockLogger.debug).toHaveBeenCalledWith('No active subscription to stop');
    });

    it('should handle unsubscribe errors gracefully', async () => {
      let resolveSubscription!: () => void; // Use definite assignment assertion to fix TS error
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        throw new Error('Unsubscribe failed');
      });

      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      // Start subscription
      const loadPromise = strategy.load(102);
      
      // Wait for subscription setup
      await new Promise(resolve => setTimeout(resolve, 50));

      // Stop subscription
      await strategy.stop();

      // Manually resolve since unsubscribe failed
      resolveSubscription();
      await loadPromise;

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Error while unsubscribing',
        expect.objectContaining({
          args: { error: expect.any(Error) },
          methodName: 'stop',
        })
      );
    });
  });

  describe('enqueueBlocks sorting', () => {
    it('should enqueue blocks in correct order (ascending height)', async () => {
      // Create blocks in random order
      const blocks = [
        { blockNumber: 103, hash: '0x103', transactions: [] },
        { blockNumber: 101, hash: '0x101', transactions: [] },
        { blockNumber: 102, hash: '0x102', transactions: [] }
      ];

      mockBlockchainProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);
      mockQueue.enqueue.mockResolvedValue(undefined);

      let resolveSubscription: () => void;
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        resolveSubscription();
      });

      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      const loadPromise = strategy.load(103);
      
      // Wait for subscription setup
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Complete subscription
      mockSubscription.unsubscribe();
      await loadPromise;

      // Check that blocks were added in correct order (ascending height)
      // Note: The sorting in enqueueBlocks is actually descending, then popped (so effectively ascending)
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(3);
      expect(mockQueue.enqueue.mock.calls[0][0].blockNumber).toBe(101);
      expect(mockQueue.enqueue.mock.calls[1][0].blockNumber).toBe(102);
      expect(mockQueue.enqueue.mock.calls[2][0].blockNumber).toBe(103);
    });
  });
});