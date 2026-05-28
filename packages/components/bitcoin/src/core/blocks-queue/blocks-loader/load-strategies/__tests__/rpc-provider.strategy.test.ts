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
  let queue: BlocksQueue;
  const preloadCount = 4;
  const defaultBlockSize = 1000;
  const maxRpcReplyBytes = 10_000;

  beforeEach(() => {
    queue = new BlocksQueue({
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
      getManyBlocksRawByHeights: jest.fn(),
      getManyBlocksRawByKnownHashes: jest.fn(),
    } as any;

    strategy = new RpcProviderStrategy(mockLogger, mockProvider, queue, {
      maxRpcReplyBytes,
      preloadCount,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ===== preloadBlocksInfo =====

  describe('preloadBlocksInfo()', () => {
    it('reduces next preload count when observed blocks are large for the raw RPC reply budget', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 2000, height: 1 },
        { blockhash: 'hash2', total_size: 2000, height: 2 },
        { blockhash: 'hash3', total_size: 2000, height: 3 },
        { blockhash: 'hash4', total_size: 2000, height: 4 },
      ]);

      await (strategy as any).preloadBlocksInfo(10);

      // 10_000 / (2_000 * 2.1) ~= 2. Large blocks should reduce
      // the next preload window instead of growing to a huge value.
      expect((strategy as any)._currentPreloadCount).toBe(2);
    });

    it('increases next preload count for small blocks but keeps it bounded', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'hash1', total_size: 100, height: 1 },
        { blockhash: 'hash2', total_size: 100, height: 2 },
        { blockhash: 'hash3', total_size: 100, height: 3 },
        { blockhash: 'hash4', total_size: 100, height: 4 },
      ]);

      await (strategy as any).preloadBlocksInfo(100);

      // 10_000 / (100 * 2.1) would be ~47, but the cap is base*4 = 16.
      expect((strategy as any)._currentPreloadCount).toBe(16);
    });

    it('does not exceed the current preload count when selecting heights for the next preload request', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._currentPreloadCount = 2;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 1000, height: 1 },
        { blockhash: 'h2', total_size: 1000, height: 2 },
      ]);

      await (strategy as any).preloadBlocksInfo(10);
      expect(mockProvider.getManyBlocksStatsByHeights).toHaveBeenCalledWith([1, 2]);
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

  });

  // ===== loadBlocks =====

  describe('loadBlocks() - Retry Logic', () => {
    const infos = [
      { hash: 'hash1', size: 1000, height: 1 },
      { hash: 'hash2', size: 1500, height: 2 },
    ];

    it('fetches blocks on first try', async () => {
      const blocks = [createTestBlock(1, 'hash1', 1000), createTestBlock(2, 'hash2', 1500)];
      mockProvider.getManyBlocksRawByKnownHashes.mockResolvedValue(blocks.map(b => ({ hash: b.hash, height: b.height, size: b.size, bytes: Buffer.alloc(b.size) })));

      const result = await (strategy as any).loadBlocks(infos, 3);
      expect(mockProvider.getManyBlocksRawByKnownHashes).toHaveBeenCalledWith(infos);
      expect(result).toHaveLength(2);
      expect(result[0].hash).toBe('hash1');
      expect(result[1].hash).toBe('hash2');
    });

    it('retries on failure and eventually succeeds', async () => {
      const rawBlocks = [
        { hash: 'hash1', height: 1, size: 1000, bytes: Buffer.alloc(1000) },
        { hash: 'hash2', height: 2, size: 1500, bytes: Buffer.alloc(1500) },
      ];
      mockProvider.getManyBlocksRawByKnownHashes
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue(rawBlocks);

      const result = await (strategy as any).loadBlocks(infos, 3);
      expect(mockProvider.getManyBlocksRawByKnownHashes).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result[0].hash).toBe('hash1');
      expect(result[1].hash).toBe('hash2');
    });

    it('throws when raw fetch returns fewer blocks than requested known hashes', async () => {
      mockProvider.getManyBlocksRawByKnownHashes.mockResolvedValue([
        { hash: 'hash1', height: 1, size: 1000, bytes: Buffer.alloc(1000) },
        null,
      ] as any);

      await expect((strategy as any).loadBlocks(infos, 1)).rejects.toThrow(
        'RPC raw fetch returned missing blocks for known hashes: 2:hash2'
      );
      expect(mockProvider.getManyBlocksRawByKnownHashes).toHaveBeenCalledTimes(1);
    });

    it('throws after max retries and logs verbose with action field', async () => {
      mockProvider.getManyBlocksRawByKnownHashes.mockRejectedValue(new Error('Persistent error'));

      await expect((strategy as any).loadBlocks(infos, 2)).rejects.toThrow('Persistent error');
      expect(mockProvider.getManyBlocksRawByKnownHashes).toHaveBeenCalledTimes(2);
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
      mockProvider.getManyBlocksRawByKnownHashes.mockResolvedValue(blocks.map(b => ({ hash: b.hash, height: b.height, size: b.size, bytes: Buffer.alloc(b.size) })));

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
      mockProvider.getManyBlocksRawByKnownHashes.mockResolvedValue(blocks.map(b => ({ hash: b.hash, height: b.height, size: b.size, bytes: Buffer.alloc(b.size) })));

      await (strategy as any).loadAndEnqueueBlocks();
      expect(queue.length).toBe(2);
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(1);
      expect((strategy as any)._preloadedItemsQueue[0].hash).toBe('hash3');
    });

    it('forces at least 1 block even when it exceeds budget', async () => {
      (queue as any)._lastHeight = 0;
      (strategy as any)._preloadedItemsQueue = [{ hash: 'bigblock', size: 6000, height: 1 }];
      const blocks = [createTestBlock(1, 'bigblock', 6000)];
      mockProvider.getManyBlocksRawByKnownHashes.mockResolvedValue(blocks.map(b => ({ hash: b.hash, height: b.height, size: b.size, bytes: Buffer.alloc(b.size) })));

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
      mockProvider.getManyBlocksRawByKnownHashes.mockResolvedValue([
        { hash: 'h1', height: 1, size: 1000, bytes: Buffer.alloc(1000) },
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
