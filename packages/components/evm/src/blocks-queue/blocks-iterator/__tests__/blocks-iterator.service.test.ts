import { Test, TestingModule } from '@nestjs/testing';
import { AppLogger } from '@easylayer/common/logger';
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
    removed: false
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
    effectiveGasPrice: 20000000000
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
    value: '1000000000000000000', // 1 ETH in wei
    gas: 21000,
    input: '0x',
    type: '0x0',
    chainId: 1,
    v: '0x1c',
    r: `0x${'1'.repeat(64)}`,
    s: `0x${'2'.repeat(64)}`,
    gasPrice: '20000000000' // 20 gwei
  };
}

/**
 * Helper function to create a test block object.
 */
function createTestBlock(blockNumber: number, transactions: Transaction[] = []): Block {
  const receipts = transactions.map(tx => createTestReceipt(tx.hash, blockNumber));
  
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
    receipts
  };
}

describe('BlocksQueueIteratorService', () => {
  let service: BlocksQueueIteratorService;
  let mockLogger: AppLogger;
  let mockBlocksCommandExecutor: jest.Mocked<BlocksCommandExecutor>;
  let mockQueue: BlocksQueue<Block>;

  beforeEach(async () => {
    mockLogger = {
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    } as any;

    mockBlocksCommandExecutor = {
      handleBatch: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockQueue = new BlocksQueue<Block>({
      lastHeight: -1,
      maxBlockHeight: Number.MAX_SAFE_INTEGER,
      blockSize: 1048576,
      maxQueueSize: 1 * 1024 * 1024
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: AppLogger,
          useValue: mockLogger,
        },
        {
          provide: 'BlocksCommandExecutor',
          useValue: mockBlocksCommandExecutor,
        },
        {
          provide: BlocksQueueIteratorService,
          useFactory: (logger, executor) =>
            new BlocksQueueIteratorService(logger, executor, { queueIteratorBlocksBatchSize: 200 }),
          inject: [AppLogger, 'BlocksCommandExecutor'],
        },
      ],
    }).compile();

    service = module.get<BlocksQueueIteratorService>(BlocksQueueIteratorService);
    service['_queue'] = mockQueue;
  });

  afterEach(() => {
    // Clean up timer if it exists
    if (service['_timer']) {
      service['_timer'].destroy();
      service['_timer'] = null;
    }
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with correct batch size', () => {
      expect(service['_blocksBatchSize']).toBe(200);
    });

    it('should initialize resolveNextBatch as a function', () => {
      expect(typeof service.resolveNextBatch).toBe('function');
    });
  });

  describe('initBatchProcessedPromise', () => {
    it('should create a promise and resolve it immediately if queue is empty', async () => {
      // Ensure queue is empty
      expect(mockQueue.length).toBe(0);
      
      service['initBatchProcessedPromise']();
      
      expect(service['batchProcessedPromise']).toBeInstanceOf(Promise);
      expect(service['resolveNextBatch']).toBeInstanceOf(Function);
      
      // Since queue is empty, promise should resolve immediately
      await expect(service['batchProcessedPromise']).resolves.toBeUndefined();
    });

    it('should create a promise that can be resolved externally when queue has items', async () => {
      const blockMock = createTestBlock(0, [createTransaction(100)]);
      await mockQueue.enqueue(blockMock);
      
      service['initBatchProcessedPromise']();
      
      let resolved = false;
      service['batchProcessedPromise'].then(() => {
        resolved = true;
      });

      // Promise should not be resolved initially
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(resolved).toBe(false);

      // Resolve manually
      service['resolveNextBatch']();
      await service['batchProcessedPromise'];
      
      expect(resolved).toBe(true);
    });
  });

  describe('processBatch', () => {
    it('should call blocksCommandExecutor.handleBatch with correct arguments', async () => {
      const blockMock = createTestBlock(0, [createTransaction(100)]);
      
      await service['processBatch']([blockMock]);
      
      expect(mockBlocksCommandExecutor.handleBatch).toHaveBeenCalledWith({
        batch: [blockMock],
        requestId: 'mock-uuid',
      });
    });

    it('should initialize new batch processed promise', async () => {
      const blockMock = createTestBlock(0, [createTransaction(100)]);
      
      const oldPromise = service['batchProcessedPromise'];
      await service['processBatch']([blockMock]);
      
      expect(service['batchProcessedPromise']).not.toBe(oldPromise);
      expect(service['batchProcessedPromise']).toBeInstanceOf(Promise);
    });

    it('should log error and continue on handleBatch failure', async () => {
      const blockMock = createTestBlock(0, [createTransaction(100)]);
      const error = new Error('Processing failed');
      
      mockBlocksCommandExecutor.handleBatch.mockRejectedValueOnce(error);
      
      await service['processBatch']([blockMock]);
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Failed to process the batch, will retry',
        expect.objectContaining({
          methodName: 'processBatch',
          args: error,
        })
      );
    });
  });

  describe('peekNextBatch', () => {
    it('should return empty array when queue is empty', async () => {
      const batch = await service['peekNextBatch']();
      expect(batch).toEqual([]);
    });

    it('should return blocks when queue has sufficient size', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(150)]);
      
      await mockQueue.enqueue(block1);
      await mockQueue.enqueue(block2);
      
      // Move blocks to outStack for getBatchUpToSize to work
      await mockQueue.firstBlock();
      
      const batch = await service['peekNextBatch']();
      expect(batch.length).toBeGreaterThan(0);
    });
  });

  describe('resolveNextBatch getter', () => {
    it('should return the resolveNextBatch function', () => {
      service['initBatchProcessedPromise']();
      const resolveFunction = service.resolveNextBatch;
      expect(typeof resolveFunction).toBe('function');
    });
  });

  describe('isIterating getter', () => {
    it('should return false initially', () => {
      expect(service.isIterating).toBe(false);
    });

    it('should return true when iterating', async () => {
      // Start iterating
      const startPromise = service.startQueueIterating(mockQueue);
      
      expect(service.isIterating).toBe(true);
      
      // Clean up
      service.onModuleDestroy();
      await startPromise.catch(() => {}); // Ignore any errors from cleanup
    });
  });

  describe('startQueueIterating', () => {
    it('should start iterating only once', async () => {
      const startPromise1 = service.startQueueIterating(mockQueue);
      const startPromise2 = service.startQueueIterating(mockQueue);
      
      expect(service.isIterating).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith('Blocks iterating skipped: already iterating');
      
      // Clean up
      service.onModuleDestroy();
      await Promise.all([startPromise1, startPromise2]).catch(() => {});
    });

    it('should assign queue and log initialization', async () => {
      const startPromise = service.startQueueIterating(mockQueue);
      
      expect(service['_queue']).toBe(mockQueue);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Start blocks iterating',
        expect.objectContaining({
          args: { initialQueueLength: mockQueue.length }
        })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Queue assigned to iterator',
        expect.objectContaining({
          args: { currentSize: mockQueue.currentSize }
        })
      );
      
      // Clean up
      service.onModuleDestroy();
      await startPromise.catch(() => {});
    });

    it('should create exponential timer', async () => {
      const startPromise = service.startQueueIterating(mockQueue);
      
      expect(service['_timer']).not.toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('Iterator exponential timer started');
      
      // Clean up
      service.onModuleDestroy();
      await startPromise.catch(() => {});
    });
  });

  describe('onModuleDestroy', () => {
    it('should clean up resources', async () => {
      // Start iterating first
      const startPromise = service.startQueueIterating(mockQueue);
      
      expect(service.isIterating).toBe(true);
      expect(service['_timer']).not.toBeNull();
      
      // Destroy
      service.onModuleDestroy();
      
      expect(service.isIterating).toBe(false);
      expect(service['_timer']).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('Shutting down iterator');
      
      await startPromise.catch(() => {}); // Clean up promise
    });

    it('should call resolveNextBatch on destroy', () => {
      const resolveSpy = jest.fn();
      service['_resolveNextBatch'] = resolveSpy;
      
      service.onModuleDestroy();
      
      expect(resolveSpy).toHaveBeenCalled();
    });
  });

  describe('integration tests', () => {
    it('should process blocks end-to-end', async () => {
      const block1 = createTestBlock(0, [createTransaction(100)]);
      const block2 = createTestBlock(1, [createTransaction(100)]);
      
      await mockQueue.enqueue(block1);
      await mockQueue.enqueue(block2);
      
      // Initialize batch promise
      service['initBatchProcessedPromise']();
      
      // Peek next batch
      const batch = await service['peekNextBatch']();
      expect(batch.length).toBeGreaterThan(0);
      
      // Process the batch
      await service['processBatch'](batch);
      
      expect(mockBlocksCommandExecutor.handleBatch).toHaveBeenCalledWith({
        batch: expect.arrayContaining([
          expect.objectContaining({ blockNumber: expect.any(Number) })
        ]),
        requestId: 'mock-uuid',
      });
    });
  });
});