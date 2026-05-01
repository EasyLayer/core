import { Logger } from '@nestjs/common';
import { SubscribeWsProviderStrategy } from '../subscribe-ws-provider.strategy';
import { BlocksQueue } from '../../../blocks-queue';
import type { Block } from '../../../../blockchain-provider/components/block.interfaces';
import type { BlockchainProviderService } from '../../../../blockchain-provider/blockchain-provider.service';

function createBlock(blockNumber: number): Block {
  return {
    hash: `0x${'a'.repeat(63 - String(blockNumber).length)}${blockNumber}`,
    parentHash: blockNumber === 0 ? '0x' + '0'.repeat(64) : `0x${'a'.repeat(63 - String(blockNumber - 1).length)}${blockNumber - 1}`,
    blockNumber, nonce: '0x0', sha3Uncles: '0x' + '1'.repeat(64), logsBloom: '0x',
    transactionsRoot: '0x' + 'b'.repeat(64), stateRoot: '0x' + 'c'.repeat(64), receiptsRoot: '0x' + 'd'.repeat(64),
    miner: '0x' + 'f'.repeat(40), difficulty: '0x1', totalDifficulty: '0x1',
    extraData: '0x', gasLimit: 30_000_000, gasUsed: 21_000,
    timestamp: 1_700_000_000, uncles: [], size: 500, sizeWithoutReceipts: 500, transactions: [],
  } as Block;
}

describe('SubscribeWsProviderStrategy', () => {
  let mockProvider: jest.Mocked<Pick<BlockchainProviderService, 'getManyBlocksWithReceipts' | 'subscribeToNewBlocks' | 'getTracesByBlockHeight'>>;
  let mockLogger: jest.Mocked<Pick<Logger, 'warn' | 'debug'>>;
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    mockLogger = { warn: jest.fn(), debug: jest.fn() } as any;
    queue = new BlocksQueue<Block>({
      lastHeight: -1, maxQueueSize: 50 * 1024 * 1024, blockSize: 500, maxBlockHeight: Number.MAX_SAFE_INTEGER,
    });

    mockProvider = {
      getManyBlocksWithReceipts: jest.fn(),
      subscribeToNewBlocks: jest.fn(),
      getTracesByBlockHeight: jest.fn().mockResolvedValue([]),
    } as any;
  });

  afterEach(() => jest.clearAllMocks());

  function makeStrategy(opts: { catchUpBatchSize?: number; tracesEnabled?: boolean } = {}) {
    return new SubscribeWsProviderStrategy(mockLogger as any, mockProvider as any, queue, {
      catchUpBatchSize: opts.catchUpBatchSize ?? 50,
      tracesEnabled: opts.tracesEnabled ?? false,
    });
  }

  describe('catch-up on load()', () => {
    it('does nothing when gap is 0 (already synced)', async () => {
      queue = new BlocksQueue<Block>({ lastHeight: 5, maxQueueSize: 50 * 1024 * 1024, blockSize: 500, maxBlockHeight: 9999 });
      const strategy = new SubscribeWsProviderStrategy(mockLogger as any, mockProvider as any, queue, {});

      // subscribeToNewBlocks: returns a never-resolving subscription
      const unsubscribe = jest.fn();
      mockProvider.subscribeToNewBlocks.mockReturnValue(Object.assign(new Promise(() => {}), { unsubscribe }) as any);

      await strategy.stop();
      expect(mockProvider.getManyBlocksWithReceipts).not.toHaveBeenCalled();
    });

    it('fetches blocks in single request for gap ≤ catchUpBatchSize', async () => {
      const blocks = [createBlock(0), createBlock(1), createBlock(2)];
      mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);

      const unsubscribe = jest.fn();
      let subscribeCallback: ((block: Block) => void) | undefined;
      mockProvider.subscribeToNewBlocks.mockImplementation((cb: any) => {
        subscribeCallback = cb;
        const p = new Promise<void>((res) => setTimeout(res, 100));
        return Object.assign(p, { unsubscribe }) as any;
      });

      const strategy = makeStrategy({ catchUpBatchSize: 50 });
      const loadPromise = strategy.load(2);

      await new Promise((r) => setTimeout(r, 20));
      await strategy.stop();

      try { await loadPromise; } catch { /* expected on stop */ }

      expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledTimes(1);
      // Called with [0, 1, 2]
      expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([0, 1, 2], true, true);
    });

    it('fetches blocks in multiple batches for gap > catchUpBatchSize', async () => {
      const blocks5 = Array.from({ length: 5 }, (_, i) => createBlock(i));
      const blocks5b = Array.from({ length: 5 }, (_, i) => createBlock(5 + i));
      // Two batches of 5
      mockProvider.getManyBlocksWithReceipts
        .mockResolvedValueOnce(blocks5)
        .mockResolvedValueOnce(blocks5b);

      const unsubscribe = jest.fn();
      mockProvider.subscribeToNewBlocks.mockImplementation(() => {
        const p = new Promise<void>((res) => setTimeout(res, 50));
        return Object.assign(p, { unsubscribe }) as any;
      });

      // catchUpBatchSize=5, gap=9 (heights 0..9)
      queue = new BlocksQueue<Block>({ lastHeight: -1, maxQueueSize: 50 * 1024 * 1024, blockSize: 500, maxBlockHeight: 9999 });
      const strategy = new SubscribeWsProviderStrategy(mockLogger as any, mockProvider as any, queue, { catchUpBatchSize: 5 });
      const loadPromise = strategy.load(9);

      await new Promise((r) => setTimeout(r, 30));
      await strategy.stop();

      try { await loadPromise; } catch { /* expected */ }

      // Should have been called twice (two batches)
      expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledTimes(2);
    });

    it('does NOT call getTracesByBlockHeight when tracesEnabled=false', async () => {
      const blocks = [createBlock(0)];
      mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);
      const unsubscribe = jest.fn();
      mockProvider.subscribeToNewBlocks.mockImplementation(() => {
        const p = new Promise<void>((res) => setTimeout(res, 30));
        return Object.assign(p, { unsubscribe }) as any;
      });

      const strategy = makeStrategy({ tracesEnabled: false });
      const loadP = strategy.load(0);
      await new Promise((r) => setTimeout(r, 10));
      await strategy.stop();
      try { await loadP; } catch {}

      expect(mockProvider.getTracesByBlockHeight).not.toHaveBeenCalled();
    });

    it('calls getTracesByBlockHeight per block in catch-up when tracesEnabled=true', async () => {
      const blocks = [createBlock(0), createBlock(1)];
      mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);
      const unsubscribe = jest.fn();
      mockProvider.subscribeToNewBlocks.mockImplementation(() => {
        const p = new Promise<void>((res) => setTimeout(res, 30));
        return Object.assign(p, { unsubscribe }) as any;
      });

      const strategy = makeStrategy({ tracesEnabled: true, catchUpBatchSize: 50 });
      const loadP = strategy.load(1);
      await new Promise((r) => setTimeout(r, 10));
      await strategy.stop();
      try { await loadP; } catch {}

      expect(mockProvider.getTracesByBlockHeight).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop()', () => {
    it('calls unsubscribe on the subscription', async () => {
      const unsubscribe = jest.fn();
      mockProvider.subscribeToNewBlocks.mockImplementation(() => {
        const p = new Promise<void>(() => {}); // never resolves
        return Object.assign(p, { unsubscribe }) as any;
      });
      mockProvider.getManyBlocksWithReceipts.mockResolvedValue([]);

      const strategy = makeStrategy();
      strategy.load(0); // don't await

      await new Promise((r) => setTimeout(r, 10));
      await strategy.stop();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });
});
