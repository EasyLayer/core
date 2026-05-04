import { Logger } from '@nestjs/common';
import { RpcProviderStrategy } from '../rpc-provider.strategy';
import { BlocksQueue } from '../../../blocks-queue';
import type { Block } from '../../../../blockchain-provider/components/block.interfaces';
import type { BlockchainProviderService } from '../../../../blockchain-provider/blockchain-provider.service';

function createBlock(blockNumber: number, sizeBytes = 500): Block {
  return {
    hash: `0x${'a'.repeat(63 - String(blockNumber).length)}${blockNumber}`,
    parentHash:
      blockNumber === 0
        ? '0x' + '0'.repeat(64)
        : `0x${'a'.repeat(63 - String(blockNumber - 1).length)}${blockNumber - 1}`,
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
    size: sizeBytes,
    sizeWithoutReceipts: sizeBytes,
    transactions: [{ hash: '0x' + 'e'.repeat(64), nonce: 0, from: '0xfrom', to: '0xto', value: '0x0', gas: 21000, input: '0x' } as any],
    receipts: [
      {
        transactionHash: '0x' + 'e'.repeat(64),
        transactionIndex: 0,
        blockHash: '0xbh',
        blockNumber,
        from: '0xfrom',
        to: '0xto',
        cumulativeGasUsed: 21000,
        gasUsed: 21000,
        contractAddress: null,
        logs: [],
        logsBloom: '0x',
        status: '0x1' as const,
      },
    ],
  } as Block;
}

function makeQueue(lastHeight = -1): BlocksQueue<Block> {
  return new BlocksQueue<Block>({
    lastHeight,
    maxQueueSize: 50 * 1024 * 1024,
    blockSize: 500,
    maxBlockHeight: Number.MAX_SAFE_INTEGER,
  });
}

describe('RpcProviderStrategy', () => {
  let mockProvider: jest.Mocked<
    Pick<
      BlockchainProviderService,
      'getManyBlocksByHeights' | 'getManyBlocksWithReceipts' | 'getTracesByBlockHeight'
    >
  >;
  let mockLogger: jest.Mocked<Pick<Logger, 'warn' | 'debug'>>;
  let queue: BlocksQueue<Block>;

  beforeEach(() => {
    mockLogger = { warn: jest.fn(), debug: jest.fn() } as any;
    mockProvider = {
      getManyBlocksByHeights: jest.fn(),
      getManyBlocksWithReceipts: jest.fn(),
      getTracesByBlockHeight: jest.fn(),
    } as any;
    queue = makeQueue(-1);
  });

  afterEach(() => jest.clearAllMocks());

  it('uses verifyTrie=false by default', async () => {
    const blocks = [createBlock(0)];
    mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks.map((b) => ({ ...b })));
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);

    const strategy = new RpcProviderStrategy(mockLogger as any, mockProvider as any, queue, {
      maxRequestBlocksBatchSize: 8_000_000,
      basePreloadCount: 1,
      tracesEnabled: false,
    });

    await strategy.load(0);

    expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledWith([0], true, false);
    expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([0], true, false);
  });

  it('passes verifyTrie=true when explicitly enabled', async () => {
    const blocks = [createBlock(0)];
    mockProvider.getManyBlocksByHeights.mockResolvedValue(blocks.map((b) => ({ ...b })));
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);

    const strategy = new RpcProviderStrategy(mockLogger as any, mockProvider as any, queue, {
      maxRequestBlocksBatchSize: 8_000_000,
      basePreloadCount: 1,
      tracesEnabled: false,
      verifyTrie: true,
    });

    await strategy.load(0);

    expect(mockProvider.getManyBlocksByHeights).toHaveBeenCalledWith([0], true, true);
    expect(mockProvider.getManyBlocksWithReceipts).toHaveBeenCalledWith([0], true, true);
  });

  it('does not fetch traces when tracesEnabled=false', async () => {
    const blocks = [createBlock(0)];
    mockProvider.getManyBlocksByHeights.mockResolvedValue([...blocks]);
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);

    const strategy = new RpcProviderStrategy(mockLogger as any, mockProvider as any, queue, {
      maxRequestBlocksBatchSize: 8_000_000,
      basePreloadCount: 1,
      tracesEnabled: false,
    });

    await strategy.load(0);

    expect(mockProvider.getTracesByBlockHeight).not.toHaveBeenCalled();
  });

  it('fetches traces per block when tracesEnabled=true', async () => {
    const blocks = [createBlock(0), createBlock(1)];
    mockProvider.getManyBlocksByHeights.mockResolvedValue([...blocks]);
    mockProvider.getManyBlocksWithReceipts.mockResolvedValue(blocks);
    mockProvider.getTracesByBlockHeight.mockResolvedValue([]);

    const strategy = new RpcProviderStrategy(mockLogger as any, mockProvider as any, queue, {
      maxRequestBlocksBatchSize: 8_000_000,
      basePreloadCount: 2,
      tracesEnabled: true,
    });

    await strategy.load(1);

    expect(mockProvider.getTracesByBlockHeight).toHaveBeenCalledTimes(2);
  });
});
