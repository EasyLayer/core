import { BlockchainProviderService, BlockParserService, Block } from '../../../../blockchain-provider';
import { PullNetworkProviderStrategy } from '../pull-network-provider.strategy';
import { AppLogger } from '@easylayer/common/logger';
import { BlocksQueue } from '../../../blocks-queue';

function createTestBlock(height: number, hash: string, size: number): Block {
  return {
    height,
    hash,
    tx: [],
    size,
    confirmations: 0,
    strippedsize: 0,
    weight: 0,
    version: 1,
    versionHex: '00000001',
    merkleroot: '0'.repeat(64),
    time: Date.now(),
    mediantime: Date.now(),
    nonce: 0,
    bits: '0'.repeat(8),
    difficulty: '1',
    chainwork: '0'.repeat(64)
  };
}

describe('PullNetworkProviderStrategy', () => {
  let strategy: PullNetworkProviderStrategy;
  let mockLogger: jest.Mocked<AppLogger>;
  let mockProvider: jest.Mocked<BlockchainProviderService>;
  let queue: BlocksQueue<Block>;
  const basePreloadCount = 4;
  const defaultBlockSize = 123;

  beforeEach(() => {
    // Instantiate real queue with initial lastHeight = 0
    queue = new BlocksQueue<Block>(0);
    // Override queue internals (blockSize) and methods
    (queue as any)._blockSize = defaultBlockSize;
    queue.isQueueOverloaded = jest.fn().mockReturnValue(false);

    mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    mockProvider = {
      getManyBlocksStatsByHeights: jest.fn(),
      getManyBlocksByHashes: jest.fn(),
    } as any;

    // Stub parser to avoid Buffer errors
    jest.spyOn(BlockParserService, 'parseRawBlock')
      .mockImplementation((hex, height) => createTestBlock(height, hex, hex.length));

    strategy = new PullNetworkProviderStrategy(
      mockLogger,
      mockProvider,
      queue,
      { maxRequestBlocksBatchSize: 10, concurrency: 1, basePreloadCount }
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // reset internal queue state
    (queue as any)._lastHeight = 0;
    (queue as any)._size = 0;
    // reset strategy state
    (strategy as any)._preloadedItemsQueue = [];
    (strategy as any)._lastPreloadCount = 0;
    (strategy as any)._lastLoadedCount = 0;
    (strategy as any)._maxPreloadCount = basePreloadCount;
  });

  describe('load', () => {
    it('throws if max height reached', async () => {
      // set queue._maxBlockHeight < last height
      (queue as any)._maxBlockHeight = 100;
      (queue as any)._lastHeight = 101;
      await expect(strategy.load(200)).rejects.toThrow('Reached max block height');
    });

    it('throws if current network height reached', async () => {
      (queue as any)._lastHeight = 50;
      await expect(strategy.load(50)).rejects.toThrow('Reached current network height');
    });

    it('throws if queue is full', async () => {
      (queue as any)._lastHeight = 10;
      // set size >= maxQueueSize
      (queue as any)._size = (queue as any)._maxQueueSize;
      await expect(strategy.load(20)).rejects.toThrow('The queue is full');
    });

    it('returns early if overloaded after preload', async () => {
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 5, height: 11 }
      ]);
      (queue as any)._lastHeight = 10;
      queue.isQueueOverloaded = jest.fn().mockReturnValue(true);

      await strategy.load(20);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'The queue is overloaded', expect.any(Object)
      );
    });
  });

  describe('stop', () => {
    it('clears the preload queue', async () => {
      (strategy as any)._preloadedItemsQueue = [{ hash: 'h', size: 1, height: 1 }];
      await strategy.stop();
      expect((strategy as any)._preloadedItemsQueue).toHaveLength(0);
    });
  });

    describe('preloadBlocksInfo', () => {
    it('fills queue with stats', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: 10, height: 1 },
        { blockhash: 'h2', total_size: 20, height: 2 }
      ]);
      await (strategy as any).preloadBlocksInfo(2);
      expect((strategy as any)._preloadedItemsQueue.map((x: any) => x.height)).toEqual([1, 2]);
    });

    it('uses default size if total_size is null', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: null, height: 1 }
      ]);
      await (strategy as any).preloadBlocksInfo(1);
      expect((strategy as any)._preloadedItemsQueue[0].size).toBe(defaultBlockSize);
    });

    it('throws on missing hash or height', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: null, total_size: 10, height: null }
      ] as any);
      await expect((strategy as any).preloadBlocksInfo(1))
        .rejects.toThrow('Block stats missing required hash and height');
    });

    it('does not change maxPreloadCount when ratio between 0.5 and 1', async () => {
      (strategy as any)._lastPreloadCount = 4;
      (strategy as any)._lastLoadedCount = 3;
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([]);
      const before = (strategy as any)._maxPreloadCount;
      await (strategy as any).preloadBlocksInfo(0);
      expect((strategy as any)._maxPreloadCount).toBe(before);
    });

    it('uses default size if total_size is null', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: 'h1', total_size: null, height: 1 }
      ]);
      await (strategy as any).preloadBlocksInfo(1);
      expect((strategy as any)._preloadedItemsQueue[0].size).toBe(defaultBlockSize);
    });

    it('throws on missing hash or height', async () => {
      (queue as any)._lastHeight = 0;
      mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
        { blockhash: null, total_size: 10, height: null }
      ] as any);
      await expect((strategy as any).preloadBlocksInfo(1))
        .rejects.toThrow('Block stats missing required hash and height');
    });

    it('adjusts maxPreloadCount up when fully consumed (ratio ≥ 0.9)', async () => {
    // lastPreloadCount = 10, lastLoadedCount = 10 => ratio = 1.0 (> 0.9)
    (strategy as any)._lastPreloadCount = 10;
    (strategy as any)._lastLoadedCount = 10;
    (queue as any)._lastHeight = 0;
    mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([]);
    const before = (strategy as any)._maxPreloadCount;
    await (strategy as any).preloadBlocksInfo(0);
    expect((strategy as any)._maxPreloadCount).toBe(Math.round(before * 1.25));
  });

  it('adjusts maxPreloadCount up when ratio just above threshold (> 0.9)', async () => {
    // lastPreloadCount = 20, lastLoadedCount = 19 => ratio = 0.95 (> 0.9)
    (strategy as any)._lastPreloadCount = 20;
    (strategy as any)._lastLoadedCount = 19;
    (queue as any)._lastHeight = 0;
    mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([]);
    const before = (strategy as any)._maxPreloadCount;
    await (strategy as any).preloadBlocksInfo(0);
    expect((strategy as any)._maxPreloadCount).toBe(Math.round(before * 1.25));
  });

  it('adjusts maxPreloadCount down when ratio < 0.2', async () => {
    // lastPreloadCount = 10, lastLoadedCount = 1 => ratio = 0.1 (< 0.2)
    (strategy as any)._lastPreloadCount = 10;
    (strategy as any)._lastLoadedCount = 1;
    (queue as any)._lastHeight = 0;
    mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([]);
    const before = (strategy as any)._maxPreloadCount;
    await (strategy as any).preloadBlocksInfo(0);
    expect((strategy as any)._maxPreloadCount).toBe(Math.max(1, Math.round(before * 0.75)));
  });

  it('does not change maxPreloadCount when 0.2 ≤ ratio ≤ 0.9', async () => {
    // lastPreloadCount = 10, lastLoadedCount = 5 => ratio = 0.5 (between thresholds)
    (strategy as any)._lastPreloadCount = 10;
    (strategy as any)._lastLoadedCount = 5;
    (queue as any)._lastHeight = 0;
    mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([]);
    const before = (strategy as any)._maxPreloadCount;
    await (strategy as any).preloadBlocksInfo(0);
    expect((strategy as any)._maxPreloadCount).toBe(before);
  });

  it('throws on missing hash or height', async () => {
    (queue as any)._lastHeight = 0;
    mockProvider.getManyBlocksStatsByHeights.mockResolvedValue([
      { blockhash: null, total_size: 10, height: null }
    ] as any);
    await expect((strategy as any).preloadBlocksInfo(1))
      .rejects.toThrow('Block stats missing required hash and height');
  });
  });

  describe('loadBlocks', () => {
    const infos = [
      { hash: 'h1', size: 1, height: 1 },
      { hash: 'h2', size: 2, height: 2 }
    ];

    it('fetches and parses blocks on first try', async () => {
      const hexes = ['aa', 'bb'];
      mockProvider.getManyBlocksByHashes.mockResolvedValue(hexes);
      const result = await (strategy as any).loadBlocks(infos, 3);
      expect(mockProvider.getManyBlocksByHashes).toHaveBeenCalledWith(['h1', 'h2'], 0);
      expect(result.map((b:any) => b.height)).toEqual([1, 2]);
    });

    it('retries until success', async () => {
      const hexes = ['cc', 'dd'];
      const gp = mockProvider.getManyBlocksByHashes;
      gp.mockRejectedValueOnce(new Error('err1')).mockResolvedValue(hexes);
      const result = await (strategy as any).loadBlocks(infos, 2);
      expect(gp).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
    });

    it('logs and throws after max retries', async () => {
      mockProvider.getManyBlocksByHashes.mockRejectedValue(new Error('fail'));
      await expect((strategy as any).loadBlocks(infos, 1))
        .rejects.toThrow('fail');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Exceeded max retries for fetching blocks batch.',
        expect.any(Object)
      );
    });
  });
});
