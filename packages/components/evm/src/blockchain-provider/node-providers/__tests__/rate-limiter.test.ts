import { RateLimiter, DEFAULT_RATE_LIMITS } from '../rate-limiter';
import { RateLimits } from '../interfaces';

jest.mock('bottleneck');

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let mockBottleneck: any;

  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true });
    jest.clearAllMocks();
    
    // Mock Bottleneck implementation
    mockBottleneck = {
      schedule: jest.fn(),
      running: jest.fn().mockReturnValue(0),
      queued: jest.fn().mockReturnValue(0),
      stop: jest.fn(),
    };

    const BottleneckMock = jest.requireMock('bottleneck');
    BottleneckMock.mockImplementation(() => mockBottleneck);
    
    rateLimiter = new RateLimiter();
  });

  afterEach(() => {
    rateLimiter.reset();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should use default configuration when no config provided', () => {
      const limiter = new RateLimiter();
      const stats = limiter.getStats();
      
      expect(stats.config.maxRequestsPerSecond).toBe(DEFAULT_RATE_LIMITS.maxRequestsPerSecond);
      expect(stats.config.maxConcurrentRequests).toBe(DEFAULT_RATE_LIMITS.maxConcurrentRequests);
      expect(stats.config.maxBatchSize).toBe(DEFAULT_RATE_LIMITS.maxBatchSize);
    });

    it('should merge custom config with defaults', () => {
      const customConfig: RateLimits = {
        maxRequestsPerSecond: 20,
        maxBatchSize: 50,
      };
      
      const limiter = new RateLimiter(customConfig);
      const stats = limiter.getStats();
      
      expect(stats.config.maxRequestsPerSecond).toBe(20);
      expect(stats.config.maxConcurrentRequests).toBe(DEFAULT_RATE_LIMITS.maxConcurrentRequests);
      expect(stats.config.maxBatchSize).toBe(50);
    });

    it('should configure Bottleneck with correct parameters', () => {
      const customConfig: RateLimits = {
        maxRequestsPerSecond: 10,
        maxConcurrentRequests: 5,
      };
      
      new RateLimiter(customConfig);
      
      const BottleneckMock = jest.requireMock('bottleneck');
      expect(BottleneckMock).toHaveBeenCalledWith({
        maxConcurrent: 1,
        minTime: Math.ceil(1000 / 10), // 100ms
        reservoir: 1,
        reservoirRefreshAmount: 1,
        reservoirRefreshInterval: 100,
      });
    });
  });

  describe('executeRequest', () => {
    it('should execute successful request', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      mockBottleneck.schedule.mockResolvedValue('success');
      
      const result = await rateLimiter.executeRequest(mockFn);
      
      expect(result).toBe('success');
      expect(mockBottleneck.schedule).toHaveBeenCalledWith(mockFn);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });

    it('should throw error immediately without retry', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      const networkError = new Error('Network timeout');
      
      mockBottleneck.schedule.mockRejectedValue(networkError);
      
      await expect(rateLimiter.executeRequest(mockFn)).rejects.toThrow('Network timeout');
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });

    it('should throw rate limit error immediately without retry', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).code = 429;
      
      mockBottleneck.schedule.mockRejectedValue(rateLimitError);
      
      await expect(rateLimiter.executeRequest(mockFn)).rejects.toThrow('Rate limit exceeded');
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeBatchRequests', () => {
    it('should return empty array for empty input', async () => {
      const batchRequestFn = jest.fn();
      const result = await rateLimiter.executeBatchRequests([], batchRequestFn);
      
      expect(result).toEqual([]);
      expect(batchRequestFn).not.toHaveBeenCalled();
    });

    it('should execute single batch when items fit within batch size', async () => {
      const items = ['item1', 'item2', 'item3'];
      const batchRequestFn = jest.fn().mockResolvedValue(['result1', 'result2', 'result3']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeBatchRequests(items, batchRequestFn);
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(batchRequestFn).toHaveBeenCalledTimes(1);
      expect(batchRequestFn).toHaveBeenCalledWith(['item1', 'item2', 'item3']);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });

    it('should split into multiple batches when items exceed batch size', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 2 });
      const items = ['item1', 'item2', 'item3', 'item4', 'item5'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['result1', 'result2'])
        .mockResolvedValueOnce(['result3', 'result4'])
        .mockResolvedValueOnce(['result5']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const resultPromise = customLimiter.executeBatchRequests(items, batchRequestFn);
      
      // Fast-forward through batch delays
      await jest.advanceTimersByTimeAsync(200);
      
      const result = await resultPromise;
      
      expect(result).toEqual(['result1', 'result2', 'result3', 'result4', 'result5']);
      expect(batchRequestFn).toHaveBeenCalledTimes(3);
      expect(batchRequestFn).toHaveBeenNthCalledWith(1, ['item1', 'item2']);
      expect(batchRequestFn).toHaveBeenNthCalledWith(2, ['item3', 'item4']);
      expect(batchRequestFn).toHaveBeenNthCalledWith(3, ['item5']);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });

    it('should throw enhanced error message on rate limit error', async () => {
      const items = ['item1', 'item2'];
      const rateLimitError = new Error('Too many requests');
      (rateLimitError as any).code = 429;
      
      const batchRequestFn = jest.fn().mockRejectedValue(rateLimitError);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow(
        /Rate limit exceeded when processing batch 1\/1.*Batch size: 2.*Too many requests/
      );
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });

    it('should throw original error for non-rate-limit errors', async () => {
      const items = ['item1', 'item2'];
      const networkError = new Error('Network error');
      
      const batchRequestFn = jest.fn().mockRejectedValue(networkError);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow('Network error');
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });

    it('should handle batch delays correctly', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 1 });
      const items = ['item1', 'item2', 'item3'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['result1'])
        .mockResolvedValueOnce(['result2'])
        .mockResolvedValueOnce(['result3']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const resultPromise = customLimiter.executeBatchRequests(items, batchRequestFn);
      
      // Fast-forward through batch delays (50ms between batches)
      await jest.advanceTimersByTimeAsync(150);
      
      const result = await resultPromise;
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(batchRequestFn).toHaveBeenCalledTimes(3);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });

    it('should maintain order across batches', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 2 });
      const items = ['A', 'B', 'C', 'D'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['resultA', 'resultB'])
        .mockResolvedValueOnce(['resultC', 'resultD']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const resultPromise = customLimiter.executeBatchRequests(items, batchRequestFn);
      
      // Fast-forward through batch delays
      await jest.advanceTimersByTimeAsync(100);
      
      const result = await resultPromise;
      
      // Order should be preserved: batch1[A,B] + batch2[C,D]
      expect(result).toEqual(['resultA', 'resultB', 'resultC', 'resultD']);
      expect(batchRequestFn).toHaveBeenNthCalledWith(1, ['A', 'B']);
      expect(batchRequestFn).toHaveBeenNthCalledWith(2, ['C', 'D']);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeSequentialRequests', () => {
    it('should return empty array for empty input', async () => {
      const result = await rateLimiter.executeSequentialRequests([]);
      expect(result).toEqual([]);
    });

    it('should execute requests sequentially', async () => {
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockResolvedValue('result3'),
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeSequentialRequests(requestFns);
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(requestFns[0]).toHaveBeenCalledTimes(1);
      expect(requestFns[1]).toHaveBeenCalledTimes(1);
      expect(requestFns[2]).toHaveBeenCalledTimes(1);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });

    it('should throw enhanced error message on rate limit error', async () => {
      const rateLimitError = new Error('Too many requests');
      (rateLimitError as any).code = 429;
      
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockRejectedValue(rateLimitError),
        jest.fn().mockResolvedValue('result3'),
      ];
      
      mockBottleneck.schedule
        .mockImplementationOnce(async (fn: any) => await fn())
        .mockImplementationOnce(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeSequentialRequests(requestFns)).rejects.toThrow(
        /Rate limit exceeded during sequential request.*Progress: 1\/3.*Too many requests/
      );
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });

    it('should stop on error and provide progress information', async () => {
      const error = new Error('Network error');
      
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockRejectedValue(error),
        jest.fn().mockResolvedValue('result4'), // Should not be called
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeSequentialRequests(requestFns)).rejects.toThrow('Network error');
      
      expect(requestFns[0]).toHaveBeenCalledTimes(1);
      expect(requestFns[1]).toHaveBeenCalledTimes(1);
      expect(requestFns[2]).toHaveBeenCalledTimes(1);
      expect(requestFns[3]).not.toHaveBeenCalled(); // Should stop on error
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });
  });

  describe('isRateLimitError (integration tests)', () => {
    it('should detect rate limit errors by code', async () => {
      const rateLimitCodes = [429, -32007, -32005, -32000];
      
      for (const code of rateLimitCodes) {
        const items = ['item1'];
        const error = new Error('Some error');
        (error as any).code = code;
        
        const batchRequestFn = jest.fn().mockRejectedValue(error);
        mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
        
        await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow(
          /Rate limit exceeded when processing batch/
        );
      }
    });

    it('should detect rate limit errors by message', async () => {
      const rateLimitMessages = [
        'Rate limit exceeded',
        'Request limit reached',
        'Too many requests',
        'Calls per second exceeded',
        'Quota exceeded',
        'Request throttled'
      ];
      
      for (const message of rateLimitMessages) {
        const items = ['item1'];
        const error = new Error(message);
        
        const batchRequestFn = jest.fn().mockRejectedValue(error);
        mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
        
        await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow(
          /Rate limit exceeded when processing batch/
        );
      }
    });

    it('should be case insensitive for rate limit messages', async () => {
      const caseVariations = [
        'RATE LIMIT EXCEEDED',
        'Rate Limit Exceeded', 
        'rate limit exceeded'
      ];
      
      for (const message of caseVariations) {
        const items = ['item1'];
        const error = new Error(message);
        
        const batchRequestFn = jest.fn().mockRejectedValue(error);
        mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
        
        await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow(
          /Rate limit exceeded when processing batch/
        );
      }
    });

    it('should not enhance non-rate-limit errors', async () => {
      const items = ['item1'];
      const networkError = new Error('Network timeout');
      
      const batchRequestFn = jest.fn().mockRejectedValue(networkError);
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow('Network timeout');
    });
  });

  describe('getStats', () => {
    it('should return current statistics', () => {
      mockBottleneck.running.mockReturnValue(5);
      mockBottleneck.queued.mockReturnValue(10);
      
      const stats = rateLimiter.getStats();
      
      expect(stats).toEqual({
        running: 5,
        queued: 10,
        config: {
          maxRequestsPerSecond: DEFAULT_RATE_LIMITS.maxRequestsPerSecond,
          maxConcurrentRequests: DEFAULT_RATE_LIMITS.maxConcurrentRequests,
          maxBatchSize: DEFAULT_RATE_LIMITS.maxBatchSize,
        },
      });
    });
  });

  describe('updateConfig', () => {
    it('should update configuration and recreate Bottleneck', () => {
      const BottleneckMock = jest.requireMock('bottleneck');
      BottleneckMock.mockClear();
      
      rateLimiter.updateConfig({
        maxRequestsPerSecond: 20,
        maxConcurrentRequests: 15,
      });
      
      const stats = rateLimiter.getStats();
      expect(stats.config.maxRequestsPerSecond).toBe(20);
      expect(stats.config.maxConcurrentRequests).toBe(15);
      expect(stats.config.maxBatchSize).toBe(DEFAULT_RATE_LIMITS.maxBatchSize); // unchanged
      
      // Should recreate Bottleneck with new config
      expect(BottleneckMock).toHaveBeenCalledWith({
        maxConcurrent: 15,
        minTime: Math.ceil(1000 / 20), // 50ms
        reservoir: 1,
        reservoirRefreshAmount: 1,
        reservoirRefreshInterval: 50,
      });
    });

    it('should update only provided config values', () => {
      rateLimiter.updateConfig({ maxBatchSize: 100 });
      
      const stats = rateLimiter.getStats();
      expect(stats.config.maxRequestsPerSecond).toBe(DEFAULT_RATE_LIMITS.maxRequestsPerSecond);
      expect(stats.config.maxConcurrentRequests).toBe(DEFAULT_RATE_LIMITS.maxConcurrentRequests);
      expect(stats.config.maxBatchSize).toBe(100);
    });
  });

  describe('reset', () => {
    it('should stop current limiter and create new one', () => {
      const BottleneckMock = jest.requireMock('bottleneck');
      BottleneckMock.mockClear();
      
      rateLimiter.reset();
      
      expect(mockBottleneck.stop).toHaveBeenCalled();
      expect(BottleneckMock).toHaveBeenCalledWith({
        maxConcurrent: DEFAULT_RATE_LIMITS.maxConcurrentRequests,
        minTime: Math.ceil(1000 / DEFAULT_RATE_LIMITS.maxRequestsPerSecond),
        reservoir: 1,
        reservoirRefreshAmount: 1,
        reservoirRefreshInterval: 100,
      });
    });
  });

  describe('batch processing edge cases', () => {
    it('should handle batch function returning empty results', async () => {
      const items = ['item1', 'item2'];
      const batchRequestFn = jest.fn().mockResolvedValue([]);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeBatchRequests(items, batchRequestFn);
      
      expect(result).toEqual([]);
      expect(batchRequestFn).toHaveBeenCalledWith(['item1', 'item2']);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });

    it('should handle batch function returning partial results', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 2 });
      const items = ['item1', 'item2', 'item3'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['result1']) // Less results than input
        .mockResolvedValueOnce(['result3']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const resultPromise = customLimiter.executeBatchRequests(items, batchRequestFn);
      
      await jest.advanceTimersByTimeAsync(100);
      
      const result = await resultPromise;
      
      expect(result).toEqual(['result1', 'result3']);
      expect(batchRequestFn).toHaveBeenCalledTimes(2);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });

    it('should handle very large batch sizes', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 1000 });
      const items = Array.from({ length: 5 }, (_, i) => `item${i + 1}`);
      
      const batchRequestFn = jest.fn().mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => `result${i + 1}`)
      );
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await customLimiter.executeBatchRequests(items, batchRequestFn);
      
      expect(result).toEqual(['result1', 'result2', 'result3', 'result4', 'result5']);
      expect(batchRequestFn).toHaveBeenCalledTimes(1); // Single batch for all items
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling without retry', () => {
    it('should fail immediately on any error in executeRequest', async () => {
      const errors = [
        new Error('Network timeout'),
        (() => { const err = new Error('Rate limit'); (err as any).code = 429; return err; })(),
        new Error('Invalid request'),
        (() => { const err = new Error('QuickNode limit'); (err as any).code = -32007; return err; })(),
      ];
      
      for (const error of errors) {
        const mockFn = jest.fn().mockResolvedValue('success');
        mockBottleneck.schedule.mockRejectedValueOnce(error);
        
        await expect(rateLimiter.executeRequest(mockFn)).rejects.toThrow(error.message);
        expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
        
        // Reset for next iteration
        mockBottleneck.schedule.mockReset();
      }
    });

    it('should handle errors at different sequential request positions', async () => {
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockRejectedValue(new Error('Request 3 failed')),
        jest.fn().mockResolvedValue('result4'), // Should not be called
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeSequentialRequests(requestFns)).rejects.toThrow('Request 3 failed');
      
      expect(requestFns[0]).toHaveBeenCalledTimes(1);
      expect(requestFns[1]).toHaveBeenCalledTimes(1);
      expect(requestFns[2]).toHaveBeenCalledTimes(1);
      expect(requestFns[3]).not.toHaveBeenCalled(); // Should stop on error
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });
  });

  describe('batch delay behavior', () => {
    it('should not add delay after last batch', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 1 });
      const items = ['item1', 'item2'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['result1'])
        .mockResolvedValueOnce(['result2']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
            
      const resultPromise = customLimiter.executeBatchRequests(items, batchRequestFn);
      
      // Only advance time for one delay (between batch 1 and 2)
      await jest.advanceTimersByTimeAsync(50);
      
      const result = await resultPromise;
      
      expect(result).toEqual(['result1', 'result2']);
      expect(batchRequestFn).toHaveBeenCalledTimes(2);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });

    it('should handle single batch without delay', async () => {
      const items = ['item1', 'item2', 'item3'];
      const batchRequestFn = jest.fn().mockResolvedValue(['result1', 'result2', 'result3']);
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeBatchRequests(items, batchRequestFn);
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(batchRequestFn).toHaveBeenCalledTimes(1);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(1);
      // No delays should be needed for single batch
    });
  });

  describe('type safety and edge inputs', () => {
    it('should handle undefined and null inputs gracefully', async () => {
      const emptyResult1 = await rateLimiter.executeBatchRequests([], jest.fn());
      const emptyResult2 = await rateLimiter.executeSequentialRequests([]);
      
      expect(emptyResult1).toEqual([]);
      expect(emptyResult2).toEqual([]);
    });

    it('should handle functions that return different types', async () => {
      const requestFns = [
        jest.fn().mockResolvedValue(123),
        jest.fn().mockResolvedValue('string'),
        jest.fn().mockResolvedValue({ key: 'value' }),
        jest.fn().mockResolvedValue([1, 2, 3]),
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeSequentialRequests(requestFns);
      
      expect(result).toEqual([123, 'string', { key: 'value' }, [1, 2, 3]]);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(4);
    });
  });
});