import { RateLimiter } from '../rate-limiter';
import type { RateLimits } from '../interfaces';

jest.mock('bottleneck');
import Bottleneck from 'bottleneck';

const MockBottleneck = Bottleneck as jest.MockedClass<typeof Bottleneck>;

describe('RateLimiter', () => {
  let mockBottleneckInstance: jest.Mocked<Bottleneck>;
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    mockBottleneckInstance = {
      schedule: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
    } as any;

    MockBottleneck.mockImplementation(() => mockBottleneckInstance);

    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (rateLimiter) {
      await rateLimiter.stop();
    }
  });

  describe('Constructor', () => {
    it('should initialize with default configuration', () => {
      rateLimiter = new RateLimiter();

      expect(MockBottleneck).toHaveBeenCalledWith({
        maxConcurrent: 1,
        minTime: 1000,
      });
    });

    it('should initialize with custom configuration', () => {
      const config: RateLimits = {
        maxConcurrentRequests: 5,
        maxBatchSize: 20,
        requestDelayMs: 500,
      };

      rateLimiter = new RateLimiter(config);

      expect(MockBottleneck).toHaveBeenCalledWith({
        maxConcurrent: 5,
        minTime: 500,
      });
    });

    it('should use partial configuration with defaults', () => {
      const config: RateLimits = {
        maxConcurrentRequests: 3,
      };

      rateLimiter = new RateLimiter(config);

      expect(MockBottleneck).toHaveBeenCalledWith({
        maxConcurrent: 3,
        minTime: 1000,
      });
    });
  });

  describe('execute()', () => {
    beforeEach(() => {
      rateLimiter = new RateLimiter();
    });

    it('should return empty array for empty requests', async () => {
      const mockBatchRpcCall = jest.fn();
      
      const result = await rateLimiter.execute([], mockBatchRpcCall);
      
      expect(result).toEqual([]);
      expect(mockBatchRpcCall).not.toHaveBeenCalled();
      expect(mockBottleneckInstance.schedule).not.toHaveBeenCalled();
    });

    it('should execute single request correctly', async () => {
      const requests = [
        { method: 'getblock', params: ['hash1'] }
      ];
      const mockResults = ['result1'];
      const mockBatchRpcCall = jest.fn().mockResolvedValue(mockResults);
      mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());

      const result = await rateLimiter.execute(requests, mockBatchRpcCall);

      expect(result).toEqual(['result1']);
      expect(mockBottleneckInstance.schedule).toHaveBeenCalledTimes(1);
      expect(mockBatchRpcCall).toHaveBeenCalledWith([
        { method: 'getblock', params: ['hash1'] }
      ]);
    });

    it('should split large batches based on maxBatchSize', async () => {
      rateLimiter = new RateLimiter({ maxBatchSize: 2 });

      const requests = [
        { method: 'getblock', params: ['hash1'] },
        { method: 'getblock', params: ['hash2'] },
        { method: 'getblock', params: ['hash3'] },
        { method: 'getblock', params: ['hash4'] }
      ];
      const mockResults1 = ['block1', 'block2'];
      const mockResults2 = ['block3', 'block4'];
      const mockBatchRpcCall = jest.fn()
        .mockResolvedValueOnce(mockResults1)
        .mockResolvedValueOnce(mockResults2);
      mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());

      const result = await rateLimiter.execute(requests, mockBatchRpcCall);

      expect(result).toEqual(['block1', 'block2', 'block3', 'block4']);
      expect(mockBottleneckInstance.schedule).toHaveBeenCalledTimes(2);
      expect(mockBatchRpcCall).toHaveBeenNthCalledWith(1, [
        { method: 'getblock', params: ['hash1'] },
        { method: 'getblock', params: ['hash2'] }
      ]);
      expect(mockBatchRpcCall).toHaveBeenNthCalledWith(2, [
        { method: 'getblock', params: ['hash3'] },
        { method: 'getblock', params: ['hash4'] }
      ]);
    });

    it('should preserve original order in results', async () => {
      rateLimiter = new RateLimiter({ maxBatchSize: 2 });

      const requests = [
        { method: 'getblockhash', params: [1] },
        { method: 'getblock', params: ['hash1'] },
        { method: 'getblockhash', params: [2] },
        { method: 'getblock', params: ['hash2'] }
      ];

      const mockBatchRpcCall = jest.fn()
        .mockResolvedValueOnce(['hash1', 'block1'])
        .mockResolvedValueOnce(['hash2', 'block2']);
      mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());

      const result = await rateLimiter.execute(requests, mockBatchRpcCall);

      expect(result).toEqual(['hash1', 'block1', 'hash2', 'block2']);
      expect(mockBottleneckInstance.schedule).toHaveBeenCalledTimes(2);
    });

    it('should handle async bottleneck scheduling', async () => {
      const requests = [
        { method: 'getblock', params: ['hash1'] }
      ];
      const mockResults = ['result1'];
      const mockBatchRpcCall = jest.fn().mockResolvedValue(mockResults);
      
      mockBottleneckInstance.schedule.mockImplementation(async (fn: any) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return fn();
      });

      const result = await rateLimiter.execute(requests, mockBatchRpcCall);

      expect(result).toEqual(['result1']);
      expect(mockBottleneckInstance.schedule).toHaveBeenCalledTimes(1);
    });

    it('should handle errors from batchRpcCall', async () => {
      const requests = [
        { method: 'getblock', params: ['hash1'] }
      ];
      const error = new Error('RPC call failed');
      const mockBatchRpcCall = jest.fn().mockRejectedValue(error);
      mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());

      await expect(rateLimiter.execute(requests, mockBatchRpcCall)).rejects.toThrow('Failed to execute batch: RPC call failed');
    });
  });

  describe('createBatches()', () => {
    beforeEach(() => {
      rateLimiter = new RateLimiter();
    });

    it('should split array into correct batch sizes', () => {
      const items = [1, 2, 3, 4, 5, 6, 7];
      const batchSize = 3;

      const batches = rateLimiter['createBatches'](items, batchSize);

      expect(batches).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7]
      ]);
    });

    it('should handle empty array', () => {
      const items: number[] = [];
      const batchSize = 3;

      const batches = rateLimiter['createBatches'](items, batchSize);

      expect(batches).toEqual([]);
    });

    it('should handle single item', () => {
      const items = [1];
      const batchSize = 3;

      const batches = rateLimiter['createBatches'](items, batchSize);

      expect(batches).toEqual([[1]]);
    });

    it('should handle batch size larger than array', () => {
      const items = [1, 2, 3];
      const batchSize = 10;

      const batches = rateLimiter['createBatches'](items, batchSize);

      expect(batches).toEqual([[1, 2, 3]]);
    });

    it('should handle batch size of 1', () => {
      const items = [1, 2, 3];
      const batchSize = 1;

      const batches = rateLimiter['createBatches'](items, batchSize);

      expect(batches).toEqual([[1], [2], [3]]);
    });
  });

  describe('stop()', () => {
    it('should call bottleneck stop with dropWaitingJobs', async () => {
      rateLimiter = new RateLimiter();

      await rateLimiter.stop();

      expect(mockBottleneckInstance.stop).toHaveBeenCalledWith({ dropWaitingJobs: true });
    });
  });

  describe('Integration scenarios', () => {
    it('should handle complex mixed batching by original order', async () => {
      rateLimiter = new RateLimiter({ maxBatchSize: 2 });

      const requests = [
        { method: 'getblock', params: ['hash1'] },
        { method: 'getblock', params: ['hash2'] },
        { method: 'getblock', params: ['hash3'] },
        { method: 'getblockhash', params: [1] },
        { method: 'getblockhash', params: [2] },
        { method: 'getblockhash', params: [3] },
        { method: 'getblockstats', params: ['hash4'] }
      ];

      const mockBatchRpcCall = jest.fn()
        .mockResolvedValueOnce(['block1', 'block2'])
        .mockResolvedValueOnce(['block3', 'hash1'])
        .mockResolvedValueOnce(['hash2', 'hash3'])
        .mockResolvedValueOnce(['stats1']);

      mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());

      const result = await rateLimiter.execute(requests, mockBatchRpcCall);

      expect(result).toEqual([
        'block1', 'block2',
        'block3', 'hash1',
        'hash2', 'hash3',
        'stats1'
      ]);

      expect(mockBottleneckInstance.schedule).toHaveBeenCalledTimes(4);
      expect(mockBatchRpcCall).toHaveBeenNthCalledWith(1, [
        { method: 'getblock', params: ['hash1'] },
        { method: 'getblock', params: ['hash2'] }
      ]);
      expect(mockBatchRpcCall).toHaveBeenNthCalledWith(2, [
        { method: 'getblock', params: ['hash3'] },
        { method: 'getblockhash', params: [1] }
      ]);
      expect(mockBatchRpcCall).toHaveBeenNthCalledWith(3, [
        { method: 'getblockhash', params: [2] },
        { method: 'getblockhash', params: [3] }
      ]);
      expect(mockBatchRpcCall).toHaveBeenNthCalledWith(4, [
        { method: 'getblockstats', params: ['hash4'] }
      ]);
    });

    it('should maintain timing constraints through bottleneck', async () => {
      rateLimiter = new RateLimiter({ requestDelayMs: 100 });

      const requests = [
        { method: 'getblock', params: ['hash1'] },
        { method: 'getblock', params: ['hash2'] }
      ];

      const mockBatchRpcCall = jest.fn().mockResolvedValue(['result1', 'result2']);

      mockBottleneckInstance.schedule.mockImplementation(async (fn: any) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return fn();
      });

      const startTime = Date.now();
      await rateLimiter.execute(requests, mockBatchRpcCall);
      const totalTime = Date.now() - startTime;

      expect(totalTime).toBeGreaterThan(40);
      expect(mockBottleneckInstance.schedule).toHaveBeenCalledTimes(1);
    });
  });
});
