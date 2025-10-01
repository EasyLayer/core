import 'reflect-metadata';
import { BlocksQueueIteratorService } from '../blocks-iterator.service';
import { BlocksQueue } from '../../blocks-queue';
import type { Block } from '../../../blockchain-provider';

function createTransaction(size: number) {
  return {
    txid: 't'.repeat(64),
    hash: 'h'.repeat(64),
    size,
    vsize: size,
    weight: size * 4,
    version: 2,
    locktime: 0,
    vin: [],
    vout: [],
  };
}

function createTestBlock(height: number, txs: any[], sizeOverride?: number): Block {
  const txSize = txs.reduce((s, t) => s + (t.size ?? 0), 0);
  const size = sizeOverride ?? Math.max(80 + txSize, 80);
  return {
    height,
    hash: `hash_${height}`,
    tx: txs,
    size,
    strippedsize: size,
    sizeWithoutWitnesses: size,
    weight: size * 4,
    vsize: size,
    witnessSize: undefined,
    headerSize: 80,
    transactionsSize: size - 80,
    version: 1,
    versionHex: '00000001',
    merkleroot: '0'.repeat(64),
    time: Date.now(),
    mediantime: Date.now(),
    nonce: 0,
    bits: '0'.repeat(8),
    difficulty: '1',
    chainwork: '0'.repeat(64),
    nTx: txs.length,
  };
}

describe('BlocksQueueIteratorService', () => {
  let service: BlocksQueueIteratorService;
  let mockLogger: any;
  let blocksCommandExecutorMock: any;

  beforeEach(() => {
    mockLogger = {
      verbose: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    blocksCommandExecutorMock = {
      handleBatch: jest.fn().mockResolvedValue(undefined),
    };

    service = new BlocksQueueIteratorService(blocksCommandExecutorMock as any, {
      queueIteratorBlocksBatchSize: 1024,
      blockTimeMs: 60_000,
    } as any);

    (service as any).log = mockLogger;
  });

  afterEach(() => {
    try { service?.onModuleDestroy?.(); } catch {}
  });

  describe('constructor', () => {
    it('should initialize with correct batch size', () => {
      expect((service as any)._blocksBatchSize).toBe(1024);
    });

    it('should initialize resolveNextBatch as a function', () => {
      expect(typeof service.resolveNextBatch).toBe('function');
    });
  });

  describe('initBatchProcessedPromise', () => {
    it('should create a promise and resolve it immediately if queue is empty', async () => {
      (service as any)._queue = { length: 0 };
      let resolved = false;
      (service as any).initBatchProcessedPromise();
      (service as any).batchProcessedPromise.then(() => (resolved = true));
      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    it('should create a promise that can be resolved externally when queue has items', async () => {
      (service as any)._queue = { length: 2 };
      let resolved = false;
      (service as any).initBatchProcessedPromise();
      (service as any).batchProcessedPromise.then(() => (resolved = true));
      expect(resolved).toBe(false);
      (service as any)._resolveNextBatch();
      await Promise.resolve();
      expect(resolved).toBe(true);
    });
  });

  describe('processBatch', () => {
    it('should call blocksCommandExecutor.handleBatch with correct arguments', async () => {
      (service as any)._queue = { length: 1, getBatchUpToSize: async () => [] };
      const batch = [createTestBlock(1, [createTransaction(120)])];
      await (service as any).processBatch(batch);
      expect(blocksCommandExecutorMock.handleBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          batch,
          requestId: expect.any(String),
        }),
      );
    });

    it('should initialize new batch processed promise', async () => {
      (service as any)._queue = { length: 1, getBatchUpToSize: async () => [] };
      const batch = [createTestBlock(2, [createTransaction(100)])];
      await (service as any).processBatch(batch);
      expect((service as any).batchProcessedPromise).toBeInstanceOf(Promise);
    });

    it('should log error and continue on handleBatch failure', async () => {
      (service as any)._queue = { length: 1, getBatchUpToSize: async () => [] };
      blocksCommandExecutorMock.handleBatch.mockRejectedValueOnce(new Error('Processing failed'));
      const batch = [createTestBlock(3, [createTransaction(90)])];
      await (service as any).processBatch(batch);
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'Failed to process the batch, will retry',
        expect.objectContaining({
          methodName: 'processBatch',
          args: expect.any(Error),
        }),
      );
    });
  });

  describe('peekNextBatch', () => {
    it('should return empty array when queue is empty', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      (service as any)._queue = q;
      const batch = await (service as any).peekNextBatch();
      expect(batch).toEqual([]);
    });

    it('should return blocks when queue has sufficient size', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      await q.enqueue(createTestBlock(1, [createTransaction(300)]));
      await q.enqueue(createTestBlock(2, [createTransaction(300)]));

      (service as any)._queue = q;
      (service as any)._blocksBatchSize = 1024;

      const batch = await (service as any).peekNextBatch();
      expect(Array.isArray(batch)).toBe(true);
      expect(batch.length).toBeGreaterThan(0);
      const total = batch.reduce((s: any, b: any) => s + b.size, 0);
      expect(total).toBeLessThanOrEqual(1024);
    });
  });

  describe('resolveNextBatch getter', () => {
    it('should return the resolveNextBatch function', () => {
      (service as any)._queue = { length: 0 };
      (service as any).initBatchProcessedPromise();
      const fn = service.resolveNextBatch;
      expect(typeof fn).toBe('function');
    });
  });

  describe('isIterating getter', () => {
    it('should return false initially', () => {
      expect(service.isIterating).toBe(false);
    });

    it('should return true when iterating', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      await service.startQueueIterating(q);
      expect(service.isIterating).toBe(true);
    });
  });

  describe('startQueueIterating', () => {
    it('should start iterating only once', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      await service.startQueueIterating(q);
      await service.startQueueIterating(q);
      expect(mockLogger.verbose).toHaveBeenCalledWith('Blocks iterating skipped: already iterating');
    });

    it('should assign queue and log initialization', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      await service.startQueueIterating(q);
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'Start blocks iterating',
        expect.objectContaining({ args: { initialQueueLength: 0 } }),
      );
      expect(mockLogger.verbose).toHaveBeenCalledWith(
        'Queue assigned to iterator',
        expect.objectContaining({ args: expect.objectContaining({ currentSize: expect.any(Number) }) }),
      );
    });

    it('should create exponential timer', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      await service.startQueueIterating(q);
      expect(mockLogger.verbose).toHaveBeenCalledWith('Iterator exponential timer started');
      expect((service as any)._timer).toBeTruthy();
    });
  });

  describe('onModuleDestroy', () => {
    it('should clean up resources', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });
      await service.startQueueIterating(q);
      expect(service.isIterating).toBe(true);
      service.onModuleDestroy();
      expect(mockLogger.verbose).toHaveBeenCalledWith('Shutting down iterator');
      expect((service as any)._timer).toBeNull();
      expect(service.isIterating).toBe(false);
    });

    it('should call resolveNextBatch on destroy', async () => {
      (service as any)._queue = { length: 1 };
      let resolved = false;
      (service as any).initBatchProcessedPromise();
      (service as any).batchProcessedPromise.then(() => (resolved = true));
      service.onModuleDestroy();
      await Promise.resolve();
      expect(resolved).toBe(true);
    });
  });

  describe('integration tests', () => {
    it('should process blocks end-to-end', async () => {
      const q = new BlocksQueue<Block>({
        lastHeight: 0,
        maxBlockHeight: Number.MAX_SAFE_INTEGER,
        blockSize: 512,
        maxQueueSize: 10 * 1024 * 1024,
      });

      const b1 = createTestBlock(1, [createTransaction(300)]);
      const b2 = createTestBlock(2, [createTransaction(300)]);
      await q.enqueue(b1);
      await q.enqueue(b2);

      await service.startQueueIterating(q);
      (service as any)._queue = q;

      const batch = await (service as any).peekNextBatch();
      expect(batch.length).toBeGreaterThan(0);

      await (service as any).processBatch(batch);
      expect(blocksCommandExecutorMock.handleBatch).toHaveBeenCalled();
    });
  });
});
