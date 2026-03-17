import { BlockchainProviderService, Block } from '../../../../blockchain-provider';
import { P2PProviderStrategy } from '../p2p-provider.strategy';
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
    transactionsSize: size - 80,
    version: 1,
    versionHex: '00000001',
    merkleroot: '0'.repeat(64),
    time: Date.now(),
    nonce: 0,
    bits: '0'.repeat(8),
    difficulty: '1',
    nTx: 0,
  } as Block;
}

describe('P2PProviderStrategy', () => {
  let strategy: P2PProviderStrategy;
  let mockLogger: jest.Mocked<any>;
  let mockProvider: jest.Mocked<BlockchainProviderService>;
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    queue = new BlocksQueue<Block>({
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
      getManyBlocksByHeights: jest.fn(),
      subscribeToNewBlocks: jest.fn(),
    } as any;

    strategy = new P2PProviderStrategy(mockLogger, mockProvider, queue);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===== stop() =====

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

  // ===== Phase 1: catch-up =====

  describe('load() - Phase 1: P2P catch-up', () => {
    it('fetches blocks via getManyBlocksByHeights with useHex=true and verifyMerkle=true', async () => {
      (queue as any)._lastHeight = 0;
      const blocks = [createTestBlock(1, 'hash1', 1000)];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);

      // After catch-up, strategy tries to subscribe — keep it simple by mocking subscription
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

      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledWith(
        [1],
        true,
        undefined,
        true
      );
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

      expect(mockProvider.getManyBlocksByHeights).not.toHaveBeenCalled();
    });

    it('propagates catch-up errors so supervisor can reset timer', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksByHeights.mockRejectedValue(new Error('P2P fetch failed'));

      await expect(strategy.load(1)).rejects.toThrow('P2P fetch failed');
    });
  });

  // ===== Phase 2: P2P subscription =====

  describe('load() - Phase 2: P2P subscription', () => {
    it('subscribes after catch-up and enqueues incoming blocks', async () => {
      (queue as any)._lastHeight = 5;

      let blockCallback: ((b: Block) => void) | undefined;
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

      const newBlock = createTestBlock(6, 'hash6', 1000);
      await blockCallback!(newBlock);

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

      let blockCallback: ((b: Block) => void) | undefined;
      const subscriptionPromise = new Promise<void>(() => {}) as any;
      subscriptionPromise.unsubscribe = jest.fn();

      mockProvider.subscribeToNewBlocks.mockImplementation((cb: any) => {
        blockCallback = cb;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      Object.defineProperty(queue, 'isQueueFull', { get: () => true, configurable: true });
      await blockCallback!(createTestBlock(6, 'hash6', 1000));

      await expect(loadPromise).rejects.toThrow('The queue is full');
    });

    it('skips blocks with height ≤ lastHeight in subscription', async () => {
      (queue as any)._lastHeight = 5;

      let blockCallback: ((b: Block) => void) | undefined;
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

      // Old block — should be skipped
      await blockCallback!(createTestBlock(3, 'oldHash', 1000));
      expect(queue.length).toBe(0);
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'P2P strategy: skipping block with height ≤ lastHeight',
        expect.objectContaining({ module: 'blocks-queue' })
      );

      resolveSubscription();
      await loadPromise;
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
