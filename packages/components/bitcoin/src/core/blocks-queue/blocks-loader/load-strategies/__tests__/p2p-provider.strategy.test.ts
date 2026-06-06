import { P2PProviderStrategy } from '../p2p-provider.strategy';
import { BlocksQueue } from '../../../blocks-queue';
import type { BlockchainProviderService, IncomingRawBlock } from '../../../../blockchain-provider';
import type { RawBlock } from '../../../interfaces';

function createRawBlock(height: number, hash: string, size: number): RawBlock {
  return { hash, height, size, bytes: Buffer.alloc(size) };
}

function createIncomingRawBlock(hash: string, prevHash: string, size: number): IncomingRawBlock {
  return { hash, prevHash, size, bytes: Buffer.alloc(size) };
}

describe('P2PProviderStrategy', () => {
  let strategy: P2PProviderStrategy;
  let mockLogger: jest.Mocked<any>;
  let mockProvider: jest.Mocked<BlockchainProviderService>;
  let queue: BlocksQueue;

  beforeEach(() => {
    queue = new BlocksQueue({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1000,
      maxQueueSize: 10 * 1024 * 1024,
    });

    mockLogger = {
      verbose: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockProvider = {
      getManyBlocksRawByHeights: jest.fn(),
      subscribeToNewBlocks: jest.fn(),
      getOneBlockHashByHeight: jest.fn(),
    } as any;

    strategy = new P2PProviderStrategy(mockLogger, mockProvider, queue);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('stop()', () => {
    it('resolves immediately when no subscription is active', async () => {
      await expect(strategy.stop()).resolves.toBeUndefined();
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'P2P strategy stopped',
        expect.objectContaining({ module: 'blocks-queue' })
      );
    });

    it('calls unsubscribe on active subscription', async () => {
      const mockUnsubscribe = jest.fn();
      const fakeSubscription = Object.assign(Promise.resolve(), {
        unsubscribe: mockUnsubscribe,
      });
      (strategy as any)._subscription = fakeSubscription;

      await strategy.stop();
      expect(mockUnsubscribe).toHaveBeenCalled();
      expect((strategy as any)._subscription).toBeUndefined();
    });
  });

  describe('load() - Phase 1: P2P catch-up', () => {
    it('fetches blocks via getManyBlocksRawByHeights and enqueues them', async () => {
      (queue as any)._lastHeight = 0;
      const raw = createRawBlock(1, 'hash1', 1000);
      mockProvider.getManyBlocksRawByHeights.mockResolvedValue([raw]);

      let resolveSubscription!: () => void;
      const subscriptionPromise = new Promise<void>((res) => {
        resolveSubscription = res;
      }) as any;
      subscriptionPromise.unsubscribe = () => resolveSubscription();
      mockProvider.subscribeToNewBlocks.mockReturnValue(subscriptionPromise);

      const loadPromise = strategy.load(1);
      await new Promise((r) => setImmediate(r));
      resolveSubscription();
      await loadPromise;

      expect(mockProvider.getManyBlocksRawByHeights).toHaveBeenCalledWith([1]);
      expect(queue.lastHeight).toBe(1);
    });

    it('skips catch-up when already at network height', async () => {
      (queue as any)._lastHeight = 10;

      let resolveSubscription!: () => void;
      const subscriptionPromise = new Promise<void>((res) => {
        resolveSubscription = res;
      }) as any;
      subscriptionPromise.unsubscribe = () => resolveSubscription();
      mockProvider.subscribeToNewBlocks.mockReturnValue(subscriptionPromise);

      const loadPromise = strategy.load(10);
      await new Promise((r) => setImmediate(r));
      resolveSubscription();
      await loadPromise;

      expect(mockProvider.getManyBlocksRawByHeights).not.toHaveBeenCalled();
    });

    it('propagates catch-up errors so supervisor can reset timer', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksRawByHeights.mockRejectedValue(new Error('P2P fetch failed'));

      await expect(strategy.load(1)).rejects.toThrow('P2P fetch failed');
    });
  });

  describe('load() - Phase 2: P2P subscription', () => {
    it('subscribes after catch-up and enqueues incoming RawBlocks', async () => {
      (queue as any)._lastHeight = 5;

      let blockCallback: ((raw: IncomingRawBlock) => void) | undefined;
      let resolveSubscription!: () => void;
      const subscriptionPromise = new Promise<void>((res) => {
        resolveSubscription = res;
      }) as any;
      subscriptionPromise.unsubscribe = () => resolveSubscription();

      mockProvider.subscribeToNewBlocks.mockImplementation((cb: any) => {
        blockCallback = cb;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      mockProvider.getOneBlockHashByHeight.mockResolvedValue('hash5');
      await blockCallback!(createIncomingRawBlock('hash6', 'hash5', 1000));

      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(6);

      resolveSubscription();
      await loadPromise;
    });

    it('rejects when subscription emits error', async () => {
      (queue as any)._lastHeight = 5;

      let errorCallback: ((e: Error) => void) | undefined;
      const subscriptionPromise = new Promise<void>(() => {}) as any;
      subscriptionPromise.unsubscribe = jest.fn();

      mockProvider.subscribeToNewBlocks.mockImplementation((_cb: any, onErr: any) => {
        errorCallback = onErr;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      errorCallback!(new Error('P2P peer disconnected'));
      await expect(loadPromise).rejects.toThrow('P2P peer disconnected');
    });

    it('rejects when queue is full during subscription', async () => {
      (queue as any)._lastHeight = 5;

      let blockCallback: ((raw: IncomingRawBlock) => void) | undefined;
      const subscriptionPromise = new Promise<void>(() => {}) as any;
      subscriptionPromise.unsubscribe = jest.fn();

      mockProvider.subscribeToNewBlocks.mockImplementation((cb: any) => {
        blockCallback = cb;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      Object.defineProperty(queue, 'isQueueFull', { get: () => true, configurable: true });
      await blockCallback!(createIncomingRawBlock('hash6', 'hash5', 1000));

      await expect(loadPromise).rejects.toThrow('The queue is full');
    });

    it('rejects incoming live blocks that do not connect to the queue tip hash', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.getOneBlockHashByHeight.mockResolvedValue('hash5');

      let blockCallback: ((raw: IncomingRawBlock) => void) | undefined;
      const subscriptionPromise = new Promise<void>(() => {}) as any;
      subscriptionPromise.unsubscribe = jest.fn();

      mockProvider.subscribeToNewBlocks.mockImplementation((cb: any) => {
        blockCallback = cb;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      await blockCallback!(createIncomingRawBlock('badHash', 'otherTip', 1000));

      await expect(loadPromise).rejects.toThrow('live block continuity mismatch');
      expect(queue.length).toBe(0);
    });


    it('does not re-subscribe if subscription already active', async () => {
      (queue as any)._lastHeight = 5;

      let resolveExisting!: () => void;
      const existingPromise = new Promise<void>((res) => {
        resolveExisting = res;
      }) as any;
      existingPromise.unsubscribe = resolveExisting;
      (strategy as any)._subscription = existingPromise;

      resolveExisting();
      await strategy.load(5);

      expect(mockProvider.subscribeToNewBlocks).not.toHaveBeenCalled();
    });
  });
});
