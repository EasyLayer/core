import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { Block, Transaction, TransactionReceipt, Log } from '../../../blockchain-provider';
import { BlocksQueueIteratorService } from '../blocks-iterator.service';
import { BlocksQueue } from '../../blocks-queue';
import { BlocksCommandExecutor } from '../../interfaces';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

/**
 * Helper function to create a test log object.
 */
function createTestLog(logIndex: number = 0, blockNumber: number = 0): Log {
  return {
    address: `0x${'a'.repeat(40)}`,
    topics: [`0x${'1'.repeat(64)}`],
    data: `0x${'2'.repeat(64)}`,
    blockNumber,
    transactionHash: `0x${'3'.repeat(64)}`,
    transactionIndex: 0,
    blockHash: `0x${'4'.repeat(64)}`,
    logIndex,
    removed: false,
  };
}

/**
 * Helper function to create a test transaction receipt.
 */
function createTestReceipt(transactionHash: string, blockNumber: number): TransactionReceipt {
  return {
    transactionHash,
    transactionIndex: 0,
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber,
    from: `0x${'1'.repeat(40)}`,
    to: `0x${'2'.repeat(40)}`,
    cumulativeGasUsed: 21000,
    gasUsed: 21000,
    contractAddress: null,
    logs: [createTestLog(0, blockNumber)],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: '0x1',
    type: '0x0',
    effectiveGasPrice: 20000000000,
  };
}

/**
 * Helper function to create a transaction with all required properties.
 */
function createTransaction(blockNumber: number = 0, transactionIndex: number = 0): Transaction {
  const hash = `0x${'a'.repeat(63)}${transactionIndex}`;

  return {
    hash,
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber,
    transactionIndex,
    nonce: 0,
    from: `0x${'1'.repeat(40)}`,
    to: `0x${'2'.repeat(40)}`,
    value: '1000000000000000000',
    gas: 21000,
    input: '0x',
    type: '0x0',
    chainId: 1,
    v: '0x1c',
    r: `0x${'1'.repeat(64)}`,
    s: `0x${'2'.repeat(64)}`,
    gasPrice: '20000000000',
  };
}

/**
 * Helper function to create a test block object.
 */
function createTestBlock(blockNumber: number, transactions: Transaction[] = []): Block {
  const receipts = transactions.map((tx) => createTestReceipt(tx.hash, blockNumber));

  // Calculate gas used from receipts
  const gasUsed = receipts.reduce((acc, receipt) => acc + receipt.gasUsed, 0);

  // Calculate size based on transactions and receipts
  const baseSize = 500; // Base block header size
  const transactionSize = transactions.length * 150; // Approximate transaction size
  const receiptSize = receipts.length * 200; // Approximate receipt size
  const totalSize = baseSize + transactionSize + receiptSize;
  const sizeWithoutReceipts = baseSize + transactionSize;

  return {
    hash: `0x${'a'.repeat(63)}${blockNumber}`,
    parentHash: blockNumber > 0 ? `0x${'a'.repeat(63)}${blockNumber - 1}` : `0x${'0'.repeat(64)}`,
    blockNumber,
    nonce: `0x${'0'.repeat(16)}`,
    sha3Uncles: `0x${'1'.repeat(64)}`,
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: `0x${'2'.repeat(64)}`,
    stateRoot: `0x${'3'.repeat(64)}`,
    receiptsRoot: `0x${'4'.repeat(64)}`,
    miner: `0x${'5'.repeat(40)}`,
    difficulty: '1000000',
    totalDifficulty: `${1000000 * (blockNumber + 1)}`,
    extraData: '0x',
    gasLimit: 8000000,
    gasUsed,
    timestamp: Date.now() + blockNumber * 12000, // 12 second block time
    uncles: [],
    size: totalSize,
    sizeWithoutReceipts,
    transactions,
    receipts,
  };
}

describe('BlocksQueueIteratorService', () => {
  let service: BlocksQueueIteratorService;
  let mockBlocksCommandExecutor: jest.Mocked<BlocksCommandExecutor>;
  let mockQueue: BlocksQueue<Block>;

  beforeEach(async () => {
    mockBlocksCommandExecutor = {
      handleBatch: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockQueue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1048576,
      maxQueueSize: 1 * 1024 * 1024,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: 'BlocksCommandExecutor', useValue: mockBlocksCommandExecutor },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (executor) =>
            new BlocksQueueIteratorService(executor, {
              queueIteratorBlocksBatchSize: 200,
              blockTimeMs: 60_000,
            }),
          inject: ['BlocksCommandExecutor'],
        },
      ],
    }).compile();

    service = module.get<BlocksQueueIteratorService>(BlocksQueueIteratorService);
    (service as any)._queue = mockQueue;
  });

  afterEach(() => {
    try {
      jest.useRealTimers();
    } catch {}
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct batch size', () => {
      expect((service as any)._blocksBatchSize).toBe(200);
    });

    it('should initialize resolveNextBatch as a function', () => {
      expect(typeof service.resolveNextBatch).toBe('function');
    });
  });

  describe('initBatchProcessedPromise', () => {
    it('should create a promise and resolve it immediately if queue is empty', async () => {
      // Ensure queue is empty
      expect(mockQueue.length).toBe(0);

      (service as any).initBatchProcessedPromise();

      expect((service as any).batchProcessedPromise).toBeInstanceOf(Promise);
      expect((service as any)._resolveNextBatch).toBeInstanceOf(Function);

      await expect((service as any).batchProcessedPromise).resolves.toBeUndefined();
    });

    it('should create a promise that can be resolved externally when queue has items', async () => {
      const blockMock = createTestBlock(0, [createTransaction(0, 0)]);
      await mockQueue.enqueue(blockMock);

      (service as any).initBatchProcessedPromise();

      let resolved = false;
      (service as any).batchProcessedPromise.then(() => {
        resolved = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      (service as any)._resolveNextBatch();
      await (service as any).batchProcessedPromise;

      expect(resolved).toBe(true);
    });
  });

  describe('processBatch', () => {
    it('should call blocksCommandExecutor.handleBatch with correct arguments', async () => {
      const blockMock = createTestBlock(0, [createTransaction(0, 0)]);

      await (service as any).processBatch([blockMock]);

      expect(mockBlocksCommandExecutor.handleBatch).toHaveBeenCalledWith({
        batch: [blockMock],
        requestId: 'mock-uuid',
      });
    });

    it('should initialize new batch processed promise', async () => {
      const blockMock = createTestBlock(0, [createTransaction(0, 0)]);

      await (service as any).processBatch([blockMock]);

      expect((service as any).batchProcessedPromise).toBeInstanceOf(Promise);
    });
  });

  describe('peekNextBatch', () => {
    it('should return empty array when queue is empty', async () => {
      const batch = await (service as any).peekNextBatch();
      expect(batch).toEqual([]);
    });

    it('should return blocks when queue has sufficient size', async () => {
      (service as any)._blocksBatchSize = 1024;
      const block1 = createTestBlock(0, [createTransaction(0, 0)]);
      const block2 = createTestBlock(1, [createTransaction(1, 0)]);

      await mockQueue.enqueue(block1);
      await mockQueue.enqueue(block2);

      const batch = await (service as any).peekNextBatch();
      expect(batch.length).toBeGreaterThan(0);
      const total = batch.reduce((s: number, b: any) => s + b.size, 0);
      expect(total).toBeLessThanOrEqual((service as any)._blocksBatchSize);
    });
  });

  describe('resolveNextBatch getter', () => {
    it('should return the resolveNextBatch function', () => {
      (service as any).initBatchProcessedPromise();
      const resolveFunction = service.resolveNextBatch;
      expect(typeof resolveFunction).toBe('function');
    });
  });

  describe('isIterating getter', () => {
    it('should return false initially', () => {
      expect(service.isIterating).toBe(false);
    });

    it('should return true when iterating', async () => {
      const startPromise = service.startQueueIterating(mockQueue);

      expect(service.isIterating).toBe(true);

      service.onModuleDestroy();
      await startPromise.catch(() => {});
    });
  });

  describe('startQueueIterating', () => {
    it('should start iterating only once', async () => {
      const p1 = service.startQueueIterating(mockQueue);
      const p2 = service.startQueueIterating(mockQueue);

      expect(service.isIterating).toBe(true);

      service.onModuleDestroy();
      await Promise.allSettled([p1, p2]);
    });

    it('should assign queue initialization', async () => {
      const p = service.startQueueIterating(mockQueue);

      service.onModuleDestroy();
      await p.catch(() => {});
    });

    it('should create exponential timer', async () => {
      const p = service.startQueueIterating(mockQueue);

      expect((service as any)._timer).not.toBeNull();

      service.onModuleDestroy();
      await p.catch(() => {});
    });
  });

  describe('onModuleDestroy', () => {
    it('should clean up resources', async () => {
      const p = service.startQueueIterating(mockQueue);

      expect(service.isIterating).toBe(true);
      expect((service as any)._timer).not.toBeNull();

      service.onModuleDestroy();

      expect(service.isIterating).toBe(false);
      expect((service as any)._timer).toBeNull();

      await p.catch(() => {});
    });

    it('should call resolveNextBatch on destroy', () => {
      const resolveSpy = jest.fn();
      (service as any)._resolveNextBatch = resolveSpy;

      service.onModuleDestroy();

      expect(resolveSpy).toHaveBeenCalled();
    });
  });

  describe('integration tests', () => {
    it('should process blocks end-to-end', async () => {
      const block1 = createTestBlock(0, [createTransaction(0, 0)]);
      const block2 = createTestBlock(1, [createTransaction(1, 0)]);

      await mockQueue.enqueue(block1);
      await mockQueue.enqueue(block2);

      (service as any).initBatchProcessedPromise();

      const batch = await (service as any).peekNextBatch();
      expect(batch.length).toBeGreaterThan(0);

      await (service as any).processBatch(batch);

      expect(mockBlocksCommandExecutor.handleBatch).toHaveBeenCalledWith({
        batch: expect.arrayContaining([
          expect.objectContaining({ blockNumber: expect.any(Number) }),
        ]),
        requestId: 'mock-uuid',
      });
    });
  });
});
