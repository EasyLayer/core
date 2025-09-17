import { Test, TestingModule } from '@nestjs/testing';
import { AppLogger } from '@easylayer/common/logger';
import { Block, Transaction } from '../../../blockchain-provider';
import { BlocksQueueIteratorService } from '../blocks-iterator.service';
import { BlocksQueue } from '../../blocks-queue';
import { BlocksCommandExecutor } from '../../interfaces';

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

/**
 * Helper function to create a transaction with all required properties.
 */
function createTransaction(baseSize: number, witnessSize: number = 0): Transaction {
  const totalSize = baseSize + witnessSize;
  const weight = (baseSize * 4) + witnessSize;
  const vsize = Math.ceil(weight / 4);
  
  return {
    txid: `txid${baseSize}`,
    hash: `hash${baseSize}`,
    version: 1,
    size: totalSize,
    strippedsize: baseSize,
    sizeWithoutWitnesses: baseSize,
    vsize: vsize,
    weight: weight,
    witnessSize: witnessSize > 0 ? witnessSize : undefined,
    locktime: 0,
    vin: [],
    vout: [],
    fee: Math.floor(Math.random() * 1000),
    feeRate: Math.floor(Math.random() * 100),
    wtxid: witnessSize > 0 ? `wtxid${baseSize}` : undefined,
    bip125_replaceable: false
  };
}

/**
 * Helper function to create a test block object.
 */
function createTestBlock(height: number, tx: Transaction[] = []): Block {
  const totalSize = tx.reduce((acc, transaction) => acc + transaction.size, 0);
  const totalStrippedSize = tx.reduce((acc, transaction) => acc + transaction.strippedsize, 0);
  const totalWeight = tx.reduce((acc, transaction) => acc + transaction.weight, 0);
  const totalVSize = tx.reduce((acc, transaction) => acc + transaction.vsize, 0);
  const totalWitnessSize = tx.reduce((acc, transaction) => acc + (transaction.witnessSize || 0), 0);

  return {
    height,
    hash: `hash${height}`,
    tx,
    size: totalSize,
    strippedsize: totalStrippedSize,
    sizeWithoutWitnesses: totalStrippedSize,
    weight: totalWeight,
    vsize: totalVSize,
    witnessSize: totalWitnessSize > 0 ? totalWitnessSize : undefined,
    headerSize: 80,
    transactionsSize: totalSize,
    version: 1,
    versionHex: '00000001',
    merkleroot: '0'.repeat(64),
    time: Date.now(),
    mediantime: Date.now(),
    nonce: 0,
    bits: '0'.repeat(8),
    difficulty: '1',
    chainwork: '0'.repeat(64),
    nTx: tx.length
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
          expect.objectContaining({ height: expect.any(Number) })
        ]),
        requestId: 'mock-uuid',
      });
    });
  });
});