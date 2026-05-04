import { Logger } from '@nestjs/common';
import { SubscribeWsProviderStrategy } from '../subscribe-ws-provider.strategy';
import { BlocksQueue } from '../../../blocks-queue';
import type { Block } from '../../../../blockchain-provider/components/block.interfaces';
import type { BlockchainProviderService } from '../../../../blockchain-provider/blockchain-provider.service';

function createBlock(blockNumber: number): Block {
  return {
    hash: `0x${'a'.repeat(63 - String(blockNumber).length)}${blockNumber}`,
    parentHash: blockNumber === 0 ? '0x' + '0'.repeat(64) : `0x${'a'.repeat(63 - String(blockNumber - 1).length)}${blockNumber - 1}`,
    blockNumber,
    nonce: '0x0',
    sha3Uncles: '0x' + '1'.repeat(64),
    logsBloom: '0x',
    transactionsRoot: '0x' + 'b'.repeat(64),
    stateRoot: '0x' + 'c'.repeat(64),
    receiptsRoot: '0x' + 'd'.repeat(64),
    miner: '0x' + 'f'.repeat(40),
    difficulty: '0x1',
    totalDifficulty: '0x1',
    extraData: '0x',
    gasLimit: 30_000_000,
    gasUsed: 21_000,
    timestamp: 1_700_000_000,
    uncles: [],
    size: 500,
    sizeWithoutReceipts: 500,
    transactions: [],
  } as Block;
}

describe('SubscribeWsProviderStrategy', () => {
  let mockProvider: jest.Mocked<
    Pick<BlockchainProviderService, 'getManyBlocksWithReceipts' | 'subscribeToNewBlocks' | 'getTracesByBlockHeight'>
  >;
  let mockLogger: jest.Mocked<Pick<Logger, 'warn' | 'debug'>>;
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    mockLogger = { warn: jest.fn(), debug: jest.fn() } as any;
    queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxQueueSize: 50 * 1024 * 1024,
      blockSize: 500,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
    });

    mockProvider = {
      getManyBlocksWithReceipts: jest.fn(),
      subscribeToNewBlocks: jest.fn(),
      getTracesByBlockHeight: jest.fn().mockResolvedValue([]),
    } as any;
  });

  afterEach(() => jest.clearAllMocks());

  function makeStrategy(
    opts: { catchUpBatchSize?: number; tracesEnabled?: boolean; verifyTrie?: boolean } = {}
  ) {
    return new SubscribeWsProviderStrategy(mockLogger as any, mockProvider as any, queue, {
      catchUpBatchSize: opts.catchUpBatchSize ?? 50,
      tracesEnabled: opts.tracesEnabled ?? false,
      verifyTrie: opts.verifyTrie ?? false,
    });
  }

  it('uses verifyTrie=false by default for catch-up and subscription', async () => {
    const blocks = [createBlock(0), createBlock(1), createBlock(2)];
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);

    const unsubscribe = jest.fn();
    mockProvider.subscribeToNewBlocks.mockImplementation(() => {
      const p = new Promise<void>((res) => setTimeout(res, 50));
      return Object.assign(p, { unsubscribe }) as any;
    });

    const strategy = makeStrategy({ catchUpBatchSize: 50 });
    const loadPromise = strategy.load(2);
    await new Promise((r) => setTimeout(r, 20));
    await strategy.stop();
    try { await loadPromise; } catch {}

    expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([0, 1, 2], true, false);
    expect(mockProvider.subscribeToNewBlocks).toHaveBeenCalledWith(expect.any(Function), true, false);
  });

  it('passes verifyTrie=true when explicitly enabled', async () => {
    const blocks = [createBlock(0)];
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);

    const unsubscribe = jest.fn();
    mockProvider.subscribeToNewBlocks.mockImplementation(() => {
      const p = new Promise<void>((res) => setTimeout(res, 30));
      return Object.assign(p, { unsubscribe }) as any;
    });

    const strategy = makeStrategy({ verifyTrie: true });
    const loadPromise = strategy.load(0);
    await new Promise((r) => setTimeout(r, 10));
    await strategy.stop();
    try { await loadPromise; } catch {}

    expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([0], true, true);
    expect(mockProvider.subscribeToNewBlocks).toHaveBeenCalledWith(expect.any(Function), true, true);
  });

  it('does not call getTracesByBlockHeight when tracesEnabled=false', async () => {
    const blocks = [createBlock(0)];
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);
    const unsubscribe = jest.fn();
    mockProvider.subscribeToNewBlocks.mockImplementation(() => {
      const p = new Promise<void>((res) => setTimeout(res, 30));
      return Object.assign(p, { unsubscribe }) as any;
    });

    const strategy = makeStrategy({ tracesEnabled: false });
    const loadPromise = strategy.load(0);
    await new Promise((r) => setTimeout(r, 10));
    await strategy.stop();
    try { await loadPromise; } catch {}

    expect(mockProvider.getTracesByBlockHeight).not.toHaveBeenCalled();
  });

  it('calls getTracesByBlockHeight per catch-up block when tracesEnabled=true', async () => {
    const blocks = [createBlock(0), createBlock(1)];
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);
    const unsubscribe = jest.fn();
    mockProvider.subscribeToNewBlocks.mockImplementation(() => {
      const p = new Promise<void>((res) => setTimeout(res, 30));
      return Object.assign(p, { unsubscribe }) as any;
    });

    const strategy = makeStrategy({ tracesEnabled: true, catchUpBatchSize: 50 });
    const loadPromise = strategy.load(1);
    await new Promise((r) => setTimeout(r, 10));
    await strategy.stop();
    try { await loadPromise; } catch {}

    expect(mockProvider.getTracesByBlockHeight).toHaveBeenCalledTimes(2);
  });
});
