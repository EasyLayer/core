import { BlockchainProviderService, Block } from '../../../../blockchain-provider';
import { RpcProviderStrategy } from '../rpc-provider.strategy';
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

describe('RpcProviderStrategy (pure polling, no ZMQ)', () => {
  let strategy: RpcProviderStrategy;
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
    } as any;

    strategy = new RpcProviderStrategy(mockLogger, mockProvider, queue, {
      maxRpcReplyBytes,
      basePreloadCount,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===== preloadBlocksInfo =====

  describe('preloadBlocksInfo()', () => {
    it('increases maxPreloadCount when timing ratio > 1.2', async () => {
      (strategy as any)._lastLoadAndEnqueueDuration = 1250;
      (strategy as any)._previousLoadAndEnqueueDuration = 1000;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 },
      ]);

      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(1);
      expect((strategy as any)._maxPreloadCount).toBe(Math.round(before * 1.25));
    });

    it('decreases maxPreloadCount when timing ratio < 0.8', async () => {
      (strategy as any)._lastLoadAndEnqueueDuration = 700;
      (strategy as any)._previousLoadAndEnqueueDuration = 1000;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 },
      ]);

      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(1);
      expect((strategy as any)._maxPreloadCount).toBe(Math.max(1, Math.round(before * 0.75)));
    });

    it('does not change maxPreloadCount when timing is stable', async () => {
      (strategy as any)._lastLoadAndEnqueueDuration = 1000;
      (strategy as any)._previousLoadAndEnqueueDuration = 1000;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: 1 },
      ]);

      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(1);
      expect((strategy as any)._maxPreloadCount).toBe(before);
    });

    it('uses total_size when available', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 2500, height: 1 },
      ]);

      await (strategy as any).preloadBlocksInfo(1);

      const items = (strategy as any)._preloadedItemsQueue;
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({ hash: 'hash1', size: 2500, height: 1 });
    });

    it('falls back to queue.blockSize when total_size is null', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: null, height: 1 } as any,
      ]);

      await (strategy as any).preloadBlocksInfo(1);
      expect((strategy as any)._preloadedItemsQueue[0].size).toBe(defaultBlockSize);
    });

    it('throws when blockhash is missing', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: null, total_size: 1000, height: 1 } as any,
      ]);
      await expect((strategy as any).preloadBlocksInfo(1)).rejects.toThrow(
        'Block infos missing required hash and height'
      );
    });

    it('throws when height is missing', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 1000, height: null } as any,
      ]);
      await expect((strategy as any).preloadBlocksInfo(1)).rejects.toThrow(
        'Block infos missing required hash and height'
      );
    });

    it('returns early when no blocks to preload', async () => {
      (queue as any)._lastHeight = 10;
      await (strategy as any).preloadBlocksInfo(10);
      expect(mockProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
    });

    it('limits request count to maxPreloadCount', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._maxPreloadCount = 2;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 1000, height: 1 },
        { blockhash: 'h2', total_size: 1000, height: 2 },
      ]);

      await (strategy as any).preloadBlocksInfo(10);
      expect(mockProvider.getManyBlocksStatsByHeights).toHaveBeenCalledWith([1, 2]);
    });
  });

  // ===== loadBlocks =====

  describe('loadBlocks() - Retry Logic', () => {
    const infos = [
      { hash: 'hash1', size: 1000, height: 1 },
      { hash: 'hash2', size: 1500, height: 2 },
    ];

    it('fetches blocks on first try', async () => {
      const blocks = [createTestBlock(1, 'hash1', 1000), createTestBlock(2, 'hash2', 1500)];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);

      const result = await (strategy as any).loadBlocks(infos, 3);
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledWith([1, 2], true, undefined, true);
      expect(result).toEqual(blocks);
    });

    it('retries on failure and eventually succeeds', async () => {
      const blocks = [createTestBlock(1, 'hash1', 1000)];
      mockProvider.getManyBlocksByHeights
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue(blocks);

      const result = await (strategy as any).loadBlocks(infos, 3);
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledTimes(2);
      expect(result).toEqual(blocks);
    });

    it('throws after max retries and logs verbose with action field', async () => {
      mockProvider.getManyBlocksByHeights.mockRejectedValue(new Error('Persistent error'));

      await expect((strategy as any).loadBlocks(infos, 2)).rejects.toThrow('Persistent error');
      expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledTimes(2);
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'Exceeded max retries for fetching blocks batch',
        expect.objectContaining({
          module: 'blocks-queue',
          args: expect.objectContaining({ batchLength: 2, action: 'loadBlocks' }),
        })
      );
    });
  });

  // ===== enqueueBlocks =====

  describe('enqueueBlocks()', () => {
    it('enqueues blocks in ascending height order', async () => {
      (queue as any)._lastHeight = 0;
      const blocks = [
        createTestBlock(3, 'hash3', 1000),
        createTestBlock(1, 'hash1', 1000),
        createTestBlock(2, 'hash2', 1000),
      ];

      await (strategy as any).enqueueBlocks(blocks);
      expect(queue.length).toBe(3);
      expect(queue.lastHeight).toBe(3);
    });

    it('skips blocks with height ≤ lastHeight', async () => {
      (queue as any)._lastHeight = 2;
      const blocks = [
        createTestBlock(1, 'hash1', 1000),
        createTestBlock(2, 'hash2', 1000),
        createTestBlock(3, 'hash3', 1000),
      ];

      await (strategy as any).enqueueBlocks(blocks);
      expect(queue.length).toBe(1);
      expect(queue.lastHeight).toBe(3);
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'Skipping block with height ≤ lastHeight',
        expect.objectContaining({
          module: 'blocks-queue',
          args: expect.objectContaining({ blockHeight: 1 }),
        })
      );
    });
  });

  // ===== loadAndEnqueueBlocks =====

  describe('loadAndEnqueueBlocks()', () => {
    it('processes and enqueues blocks within budget', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 2000, height: 1 },
        { hash: 'hash2', size: 2000, height: 2 },
      ];
      const blocks = [createTestBlock(1, 'hash1', 2000), createTestBlock(2, 'hash2', 2000)];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);

      await (strategy as any).loadAndEnqueueBlocks();
      expect(queue.length).toBe(2);
      expect(queue.lastHeight).toBe(2);
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });

    it('keeps blocks beyond reply-byte budget in preloadedItemsQueue', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 2000, height: 1 },
        { hash: 'hash2', size: 2000, height: 2 },
        { hash: 'hash3', size: 2000, height: 3 },
      ];
      const blocks = [createTestBlock(1, 'hash1', 2000), createTestBlock(2, 'hash2', 2000)];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);

      await (strategy as any).loadAndEnqueueBlocks();
      expect(queue.length).toBe(2);
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(1);
      expect((strategy as any)._preloadedItemsQueue[0].hash).toBe('hash3');
    });

    it('forces at least 1 block even when it exceeds budget', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._preloadedItemsQueue = [{ hash: 'bigblock', size: 6000, height: 1 }];
      const blocks = [createTestBlock(1, 'bigblock', 6000)];
      mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks);

      await (strategy as any).loadAndEnqueueBlocks();
      expect(queue.length).toBe(1);
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });
  });

  // ===== stop() =====

  describe('stop()', () => {
    it('clears preloaded items queue', async () => {
      (strategy as any)._preloadedItemsQueue = [
        { hash: 'hash1', size: 1000, height: 1 },
        { hash: 'hash2', size: 1000, height: 2 },
      ];

      await strategy.stop();
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });

    // RpcProviderStrategy is pure polling — no _subscription field
    it('has no active subscription to clean up (pure polling strategy)', async () => {
      expect((strategy as any)._subscription).toBeUndefined();
      await expect(strategy.stop()).resolves.toBeUndefined();
    });
  });

  // ===== load() =====

  describe('load()', () => {
    it('does nothing when already at network height', async () => {
      (queue as any)._lastHeight = 5;
      await strategy.load(5);
      expect(mockProvider.getManyBlocksStatsByHeights).not.toHaveBeenCalled();
    });

    it('returns after catch-up (no subscription — caller timer handles next poll)', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 1000, height: 1 },
      ]);
      mockProvider.getManyBlocksByHeights.mockResolvedValue([
        createTestBlock(1, 'h1', 1000),
      ]);

      await strategy.load(1);

      expect(queue.lastHeight).toBe(1);
      // No subscribeToNewBlocks call — pure polling
      expect((mockProvider as any).subscribeToNewBlocks).toBeUndefined();
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
});
