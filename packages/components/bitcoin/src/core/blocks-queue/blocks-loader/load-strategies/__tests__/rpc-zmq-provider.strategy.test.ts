import { BlockchainProviderService, Block } from '../../../../blockchain-provider';
import { RpcZmqProviderStrategy } from '../rpc-zmq-provider.strategy';
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

describe('RpcZmqProviderStrategy (RPC catch-up + ZMQ subscription)', () => {
  let strategy: RpcZmqProviderStrategy;
  let mockLogger: jest.Mocked<any>;
  let mockProvider: jest.Mocked<BlockchainProviderService>;
  let queue: BlocksQueue<Block>;
  const basePreloadCount = 4;
  const defaultBlockSize = 1000;
  const maxRpcReplyBytes = 10_000;

  beforeEach(() => {
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: defaultBlockSize,
      maxQueueSize: 10 * 1024 * 1024,
    });

    queue.isQueueOverloaded = jest.fn().mockReturnValue(false);

    mockLogger = {
      verbose: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockProvider = {
      getManyBlocksStatsByHeights: jest.fn(),
      getManyBlocksByHeights: jest.fn(),
      hasNetworkProvidersAvailable: jest.fn().mockReturnValue(false),
      getActiveNetworkProviderName: jest.fn(),
      getNetworkProviderByName: jest.fn(),
      subscribeToNewBlocks: jest.fn(),
    } as any;

    strategy = new RpcZmqProviderStrategy(mockLogger, mockProvider, queue, {
      maxRpcReplyBytes,
      basePreloadCount,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===== stop() =====

  describe('stop()', () => {
    it('clears preloaded items queue', async () => {
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 1000, height: 1 },
      ];

      await strategy.stop();
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });

    it('calls unsubscribe on active ZMQ subscription and clears it', async () => {
      const mockUnsubscribe = jest.fn();
      const fakeSubscription = Object.assign(Promise.resolve(), {
        unsubscribe: mockUnsubscribe,
      });
      (strategy as any)._subscription = fakeSubscription;

      await strategy.stop();
      expect(mockUnsubscribe).toHaveBeenCalled();
      expect((strategy as any)._subscription).toBeUndefined();
    });

    it('resolves cleanly when no subscription is active', async () => {
      await expect(strategy.stop()).resolves.toBeUndefined();
    });
  });

  // ===== load() — Phase 1: RPC catch-up =====

  describe('load() - Phase 1: RPC catch-up', () => {
    it('does not call provider when already at network height', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(false);

      await strategy.load(5);
      expect(mockProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
    });

    it('throws when queue is full during catch-up', async () => {
      (queue as any)._lastHeight = 0;
      Object.defineProperty(queue, 'isQueueFull', { get: () => true, configurable: true });

      await expect(strategy.load(5)).rejects.toThrow('The queue is full, waiting before retry');
    });

    it('throws when queue is overloaded after preload', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 1000, height: 1 },
      ]);
      (queue.isQueueOverloaded as jest.Mock).mockReturnValue(true);

      await expect(strategy.load(1)).rejects.toThrow('The queue is overloaded, waiting before retry');
    });
  });

  // ===== load() — Phase 2: ZMQ subscription =====

  describe('load() - Phase 2: ZMQ subscription', () => {
    it('returns without subscribing when no network providers available', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(false);

      await strategy.load(5);
      expect(mockProvider.subscribeToNewBlocks).not.toHaveBeenCalled();
    });

    it('subscribes and enqueues incoming blocks after catch-up', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(true);

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

      expect(blockCallback).toBeDefined();

      const newBlock = createTestBlock(6, 'newHash', 1000);
      await blockCallback!(newBlock);
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(6);

      resolveSubscription();
      await loadPromise;
    });

    it('rejects load() when subscription emits error', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(true);

      let errorCallback: ((e: Error) => void) | undefined;
      const subscriptionPromise = new Promise<void>(() => {}) as any;
      subscriptionPromise.unsubscribe = jest.fn();

      mockProvider.subscribeToNewBlocks.mockImplementation((_cb: any, onErr: any) => {
        errorCallback = onErr;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      expect(errorCallback).toBeDefined();
      errorCallback!(new Error('ZMQ disconnected'));

      await expect(loadPromise).rejects.toThrow('ZMQ disconnected');
    });

    it('rejects load() when queue becomes full during subscription', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(true);

      let blockCallback: ((b: Block) => void) | undefined;
      const subscriptionPromise = new Promise<void>(() => {}) as any;
      subscriptionPromise.unsubscribe = jest.fn();

      mockProvider.subscribeToNewBlocks.mockImplementation((cb: any) => {
        blockCallback = cb;
        return subscriptionPromise;
      });

      const loadPromise = strategy.load(5);
      await new Promise((r) => setImmediate(r));

      expect(blockCallback).toBeDefined();
      Object.defineProperty(queue, 'isQueueFull', { get: () => true, configurable: true });
      await blockCallback!(createTestBlock(6, 'hash6', 1000));

      await expect(loadPromise).rejects.toThrow('The queue is full');
    });

    it('does not re-subscribe if subscription already active', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(true);

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

    it('skips incoming blocks with height ≤ lastHeight', async () => {
      (queue as any)._lastHeight = 5;
      mockProvider.hasNetworkProvidersAvailable.mockReturnValue(true);

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

      await blockCallback!(createTestBlock(3, 'oldHash', 1000));
      expect(queue.length).toBe(0);
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'RPC+ZMQ strategy: skipping block with height ≤ lastHeight',
        expect.objectContaining({ module: 'blocks-queue' })
      );

      resolveSubscription();
      await loadPromise;
    });
  });
});
