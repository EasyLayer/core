import { SubscribeBlocksProviderStrategy } from '../subscribe-blocks-provider.strategy';
import { StrategyNames } from '../load-strategy.interface';

// Mock dependencies
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as jest.Mocked<any>;

const mockBlockchainProvider = {
  subscribeToNewBlocks: jest.fn(),
  getManyBlocksByHeights: jest.fn(),
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

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([mockBlock]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);
      mockQueue.enqueue.mockResolvedValue(undefined);

      const loadPromise = strategy.load(102);

      // Wait for subscription to be set up
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate subscription callback
      const subscriptionCallback = mockBlockchainProvider.subscribeToNewBlocks.mock.calls[0][0];
      await subscriptionCallback(mockBlock);

      // Trigger unsubscribe to resolve the promise
      mockSubscription.unsubscribe();
      
      await loadPromise;

      expect(mockBlockchainProvider.getManyBlocksByHeights).toHaveBeenCalledWith([101, 102], true);
      expect(mockQueue.enqueue).toHaveBeenCalledWith(mockBlock);
      expect(mockBlockchainProvider.subscribeToNewBlocks).toHaveBeenCalled();
    });

    it('should skip initial catchup when queue is already at target height', async () => {
      mockQueue.lastHeight = 102;
      
      let resolveSubscription: () => void;
      const mockSubscription = new Promise<void>((resolve) => {
        resolveSubscription = resolve;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        resolveSubscription();
      });

      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      const loadPromise = strategy.load(102);
      
      // Trigger unsubscribe to resolve the promise
      mockSubscription.unsubscribe();
      
      await loadPromise;

      expect(mockBlockchainProvider.getManyBlocksByHeights).not.toHaveBeenCalled();
      expect(mockBlockchainProvider.subscribeToNewBlocks).toHaveBeenCalled();
    });

    it('should throw error when gap is too large for catchup', async () => {
      mockQueue.lastHeight = 0;

      await expect(strategy.load(150)).rejects.toThrow('Gap too large for subscription strategy');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Initial catch-up gap too large',
        expect.objectContaining({
          args: expect.objectContaining({
            blocksToFetch: 150,
            maxAllowedGap: 100,
          })
        })
      );
    });

    it('should handle max height reached error in subscription callback', async () => {
      let rejectSubscription: (error: Error) => void;
      const mockSubscription = new Promise<void>((resolve, reject) => {
        rejectSubscription = reject;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn();

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockImplementation((callback) => {
        // Simulate callback execution that will throw error due to max height reached
        setTimeout(async () => {
          try {
            await callback(mockBlock);
          } catch (error) {
            rejectSubscription(error as Error);
          }
        }, 0);
        return mockSubscription;
      });

      // Set condition that will cause error in callback
      mockQueue.isMaxHeightReached = true;

      await expect(strategy.load(102)).rejects.toThrow('Reached max block height');
      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
    });

    it('should handle queue full error in subscription callback', async () => {
      let rejectSubscription: (error: Error) => void;
      const mockSubscription = new Promise<void>((resolve, reject) => {
        rejectSubscription = reject;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn();

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockImplementation((callback) => {
        setTimeout(async () => {
          try {
            await callback(mockBlock);
          } catch (error) {
            rejectSubscription(error as Error);
          }
        }, 0);
        return mockSubscription;
      });

      mockQueue.isQueueFull = true;

      await expect(strategy.load(102)).rejects.toThrow('The queue is full');
      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
    });

    it('should handle current network height reached error in subscription callback', async () => {
      let rejectSubscription: (error: Error) => void;
      const mockSubscription = new Promise<void>((resolve, reject) => {
        rejectSubscription = reject;
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn();

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockImplementation((callback) => {
        setTimeout(async () => {
          try {
            await callback(mockBlock);
          } catch (error) {
            rejectSubscription(error as Error);
          }
        }, 0);
        return mockSubscription;
      });

      mockQueue.lastHeight = 105; // Higher than target height 102

      await expect(strategy.load(102)).rejects.toThrow('Reached current network height');
      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
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

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      const loadPromise = strategy.load(102);

      // Wait for subscription to be set up
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate subscription callback with old block
      const subscriptionCallback = mockBlockchainProvider.subscribeToNewBlocks.mock.calls[0][0];
      await subscriptionCallback(oldBlock);

      // Trigger unsubscribe to resolve the promise
      mockSubscription.unsubscribe();
      
      await loadPromise;

      expect(mockQueue.enqueue).not.toHaveBeenCalled();
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
      const mockSubscription = new Promise<void>(() => {
        // Never resolves - simulates long-running subscription
      }) as Promise<void> & { unsubscribe: () => void };
      
      mockSubscription.unsubscribe = jest.fn();

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      // First call - starts subscription
      const firstLoad = strategy.load(102);
      
      // Wait a bit for subscription to be set up
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Second call should return immediately without creating new subscription
      await strategy.load(102);

      expect(mockBlockchainProvider.subscribeToNewBlocks).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith('Already subscribed to new blocks');
      
      // Clean up
      await strategy.stop();
    });
  });

  describe('stop', () => {
    it('should unsubscribe from active subscription', async () => {
      const mockSubscription = new Promise<void>(() => {}) as Promise<void> & { unsubscribe: () => void };
      mockSubscription.unsubscribe = jest.fn();

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      // Start subscription
      strategy.load(102);
      
      // Wait for subscription to be set up
      await new Promise(resolve => setTimeout(resolve, 10));

      // Stop subscription
      await strategy.stop();

      expect(mockSubscription.unsubscribe).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('Unsubscribed from new blocks');
    });

    it('should handle stop when no active subscription exists', async () => {
      await strategy.stop();

      expect(mockLogger.debug).toHaveBeenCalledWith('No active subscription to stop');
    });

    it('should handle unsubscribe errors gracefully', async () => {
      const mockSubscription = new Promise<void>(() => {}) as Promise<void> & { unsubscribe: () => void };
      mockSubscription.unsubscribe = jest.fn().mockImplementation(() => {
        throw new Error('Unsubscribe failed');
      });

      mockBlockchainProvider.getManyBlocksByHeights.mockResolvedValue([]);
      mockBlockchainProvider.subscribeToNewBlocks.mockReturnValue(mockSubscription);

      // Start subscription
      strategy.load(102);
      
      // Wait for subscription to be set up
      await new Promise(resolve => setTimeout(resolve, 10));

      // Stop subscription
      await strategy.stop();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error while unsubscribing',
        expect.objectContaining({
          args: { error: expect.any(Error) },
          methodName: 'stop',
        })
      );
    });
  });
});