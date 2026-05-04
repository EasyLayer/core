import 'reflect-metadata';
import { BlocksQueueIteratorService } from '../blocks-iterator.service';
import { BlocksQueue } from '../../blocks-queue';
import type { Block } from '../../../blockchain-provider/components/block.interfaces';

function createBlock(blockNumber: number, size = 512): Block {
  return {
    hash: `0x${String(blockNumber).padStart(64, '0')}`,
    parentHash: blockNumber <= 0 ? `0x${'0'.repeat(64)}` : `0x${String(blockNumber - 1).padStart(64, '0')}`,
    blockNumber,
    nonce: '0x0',
    sha3Uncles: `0x${'1'.repeat(64)}`,
    logsBloom: '0x',
    transactionsRoot: `0x${'2'.repeat(64)}`,
    stateRoot: `0x${'3'.repeat(64)}`,
    receiptsRoot: `0x${'4'.repeat(64)}`,
    miner: `0x${'5'.repeat(40)}`,
    difficulty: '0x1',
    totalDifficulty: '0x1',
    extraData: '0x',
    gasLimit: 30_000_000,
    gasUsed: 21_000,
    timestamp: 1_700_000_000,
    uncles: [],
    size,
    sizeWithoutReceipts: size,
    transactions: [],
  } as Block;
}

describe('BlocksQueueIteratorService', () => {
  let service: BlocksQueueIteratorService;
  let executor: { handleBatch: jest.Mock };

  beforeEach(() => {
    executor = {
      handleBatch: jest.fn().mockResolvedValue(undefined),
    };

    service = new BlocksQueueIteratorService(executor as any, {
      queueIteratorBlocksBatchSize: 1024,
      blockTimeMs: 12_000,
    } as any);

    (service as any).log = {
      debug: jest.fn(),
      verbose: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    };
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllMocks();
  });

  it('initializes batch size from config', () => {
    expect((service as any)._blocksBatchSize).toBe(1024);
  });

  it('peekNextBatch returns blocks up to configured size', async () => {
    const queue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 512,
      maxQueueSize: 10 * 1024 * 1024,
    });
    await queue.enqueue(createBlock(0, 400));
    await queue.enqueue(createBlock(1, 400));
    await queue.enqueue(createBlock(2, 400));

    (service as any)._queue = queue;
    const batch = await (service as any).peekNextBatch();

    expect(batch.length).toBeGreaterThan(0);
    expect(batch.reduce((sum: number, block: Block) => sum + block.size, 0)).toBeLessThanOrEqual(1024);
  });

  it('processBatch delegates to blocksCommandExecutor.handleBatch', async () => {
    (service as any)._queue = { length: 1, getBatchUpToSize: async () => [] };
    const batch = [createBlock(1, 300)];

    await (service as any).processBatch(batch);

    expect(executor.handleBatch).toHaveBeenCalledWith(
      expect.objectContaining({ batch, requestId: expect.any(String) })
    );
  });

  it('resolves batchProcessedPromise when processing fails', async () => {
    (service as any)._queue = { length: 1, getBatchUpToSize: async () => [] };
    executor.handleBatch.mockRejectedValueOnce(new Error('fail'));

    await (service as any).processBatch([createBlock(1, 300)]);

    let resolved = false;
    (service as any).batchProcessedPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(true);
  });
});
