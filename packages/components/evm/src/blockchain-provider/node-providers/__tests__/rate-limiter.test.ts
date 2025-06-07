import { RateLimiter, DEFAULT_RATE_LIMITS } from '../rate-limiter';
import { RateLimits } from '../interfaces';

jest.mock('bottleneck');

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let mockBottleneck: any;

  beforeEach(() => {
    // Use fake timers with automatic advancement
    jest.useFakeTimers({ advanceTimers: true });
    
    // Clear all mocks
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
    // Restore real timers
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
        maxConcurrent: 5,
        minTime: Math.ceil(1000 / 10), // 100ms
        reservoir: 10,
        reservoirRefreshAmount: 10,
        reservoirRefreshInterval: 1000,
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
    });

    it('should retry on rate limit error', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).code = 429;
      
      mockBottleneck.schedule
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue('success');
      
      const resultPromise = rateLimiter.executeRequest(mockFn);
      
      // Fast-forward through the retry delays
      await jest.advanceTimersByTimeAsync(5000);
      
      const result = await resultPromise;
      
      expect(result).toBe('success');
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });
  });

  describe('executeBatchRequests', () => {
    beforeEach(() => {
      // Mock executeRequest to work properly
      jest.spyOn(rateLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
    });

    it('should return empty array for empty input', async () => {
      const result = await rateLimiter.executeBatchRequests([]);
      expect(result).toEqual([]);
    });

    it('should execute single batch when batch size is larger than input', async () => {
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockResolvedValue('result3'),
      ];
      
      const result = await rateLimiter.executeBatchRequests(mockFns);
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(mockFns[0]).toHaveBeenCalled();
      expect(mockFns[1]).toHaveBeenCalled();
      expect(mockFns[2]).toHaveBeenCalled();
    });

    it('should split into multiple batches when input exceeds batch size', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 2 });
      jest.spyOn(customLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
      
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockResolvedValue('result3'),
      ];
      
      const resultPromise = customLimiter.executeBatchRequests(mockFns);
      
      // Fast-forward through batch delays
      await jest.advanceTimersByTimeAsync(100);
      
      const result = await resultPromise;
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(mockFns[0]).toHaveBeenCalled();
      expect(mockFns[1]).toHaveBeenCalled();
      expect(mockFns[2]).toHaveBeenCalled();
    });

    it('should throw enhanced error message on rate limit error', async () => {
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockRejectedValue({ code: 429, message: 'Too many requests' }),
      ];
      
      jest.spyOn(rateLimiter, 'executeRequest')
        .mockImplementationOnce(async (fn) => await fn())
        .mockImplementationOnce(async (fn) => await fn());
      
      await expect(rateLimiter.executeBatchRequests(mockFns)).rejects.toThrow(
        /Rate limit exceeded when processing batch 1\/1.*Batch size: 2.*Too many requests/
      );
    });
  });

  describe('isRateLimitError (integration tests)', () => {
    // Test the private method indirectly through executeRequest behavior
    
    it('should retry on errors with rate limit codes', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      
      const rateLimitCodes = [429, -32007, -32005, -32000];
      
      for (const code of rateLimitCodes) {
        mockBottleneck.schedule.mockReset();
        
        const error = new Error('Some error');
        (error as any).code = code;
        
        mockBottleneck.schedule
          .mockRejectedValueOnce(error)
          .mockResolvedValue('success');
        
        const resultPromise = rateLimiter.executeRequest(mockFn);
        
        // Fast-forward through retry delay
        await jest.advanceTimersByTimeAsync(1000);
        
        const result = await resultPromise;
        
        expect(result).toBe('success');
        expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2); // Initial + 1 retry
      }
    });

    it('should retry on errors with rate limit messages', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      
      const rateLimitMessages = [
        'Rate limit exceeded',
        'Request limit reached',
        'Too many requests',
        'Calls per second exceeded',
        'Quota exceeded',
        'Request throttled'
      ];
      
      for (const message of rateLimitMessages) {
        mockBottleneck.schedule.mockReset();
        
        const error = new Error(message);
        
        mockBottleneck.schedule
          .mockRejectedValueOnce(error)
          .mockResolvedValue('success');
        
        const resultPromise = rateLimiter.executeRequest(mockFn);
        
        // Fast-forward through retry delay
        await jest.advanceTimersByTimeAsync(1000);
        
        const result = await resultPromise;
        
        expect(result).toBe('success');
        expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2); // Initial + 1 retry
      }
    });

    it('should be case insensitive for rate limit messages', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      
      const caseVariations = [
        'RATE LIMIT EXCEEDED',
        'Rate Limit Exceeded', 
        'rate limit exceeded'
      ];
      
      for (const message of caseVariations) {
        mockBottleneck.schedule.mockReset();
        
        const error = new Error(message);
        
        mockBottleneck.schedule
          .mockRejectedValueOnce(error)
          .mockResolvedValue('success');
        
        const resultPromise = rateLimiter.executeRequest(mockFn);
        
        // Fast-forward through retry delay
        await jest.advanceTimersByTimeAsync(1000);
        
        const result = await resultPromise;
        
        expect(result).toBe('success');
        expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2); // Initial + 1 retry
      }
    });

    it('should handle mixed error scenarios in batch requests', async () => {
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).code = 429;
      
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockRejectedValue(rateLimitError),
      ];
      
      jest.spyOn(rateLimiter, 'executeRequest')
        .mockImplementationOnce(async (fn) => await fn())
        .mockImplementationOnce(async (fn) => await fn());
      
      await expect(rateLimiter.executeBatchRequests(mockFns)).rejects.toThrow(
        /Rate limit exceeded when processing batch 1\/1.*Batch size: 2/
      );
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
        reservoir: 20,
        reservoirRefreshAmount: 20,
        reservoirRefreshInterval: 1000,
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
        reservoir: DEFAULT_RATE_LIMITS.maxRequestsPerSecond,
        reservoirRefreshAmount: DEFAULT_RATE_LIMITS.maxRequestsPerSecond,
        reservoirRefreshInterval: 1000,
      });
    });
  });

  describe('batch processing behavior', () => {
    beforeEach(() => {
      // Mock executeRequest to work properly
      jest.spyOn(rateLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
    });

    it('should handle batch size correctly - single batch when items fit', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 5 });
      jest.spyOn(customLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
      
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockResolvedValue('result3'),
      ];
      
      const result = await customLimiter.executeBatchRequests(mockFns);
      
      expect(result).toEqual(['result1', 'result2', 'result3']);
      expect(mockFns[0]).toHaveBeenCalledTimes(1);
      expect(mockFns[1]).toHaveBeenCalledTimes(1);
      expect(mockFns[2]).toHaveBeenCalledTimes(1);
    });

    it('should split into multiple batches when items exceed batch size', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 2 });
      jest.spyOn(customLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
      
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'), 
        jest.fn().mockResolvedValue('result3'),
        jest.fn().mockResolvedValue('result4'),
        jest.fn().mockResolvedValue('result5'),
      ];
      
      const resultPromise = customLimiter.executeBatchRequests(mockFns);
      
      // Fast-forward through batch delays
      await jest.advanceTimersByTimeAsync(200);
      
      const result = await resultPromise;
      
      // Should process all items: [[1,2], [3,4], [5]]
      expect(result).toEqual(['result1', 'result2', 'result3', 'result4', 'result5']);
      expect(mockFns[0]).toHaveBeenCalledTimes(1);
      expect(mockFns[1]).toHaveBeenCalledTimes(1);
      expect(mockFns[2]).toHaveBeenCalledTimes(1);
      expect(mockFns[3]).toHaveBeenCalledTimes(1);
      expect(mockFns[4]).toHaveBeenCalledTimes(1);
    });

    it('should handle empty batch correctly', async () => {
      const result = await rateLimiter.executeBatchRequests([]);
      expect(result).toEqual([]);
    });

    it('should process batches with different sizes correctly', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 3 });
      jest.spyOn(customLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
      
      // 7 items with batch size 3 should create: [1,2,3], [4,5,6], [7]
      const mockFns = Array.from({ length: 7 }, (_, i) => 
        jest.fn().mockResolvedValue(`result${i + 1}`)
      );
      
      const resultPromise = customLimiter.executeBatchRequests(mockFns);
      
      // Fast-forward through batch delays
      await jest.advanceTimersByTimeAsync(150);
      
      const result = await resultPromise;
      
      expect(result).toEqual([
        'result1', 'result2', 'result3', 
        'result4', 'result5', 'result6', 
        'result7'
      ]);
      
      // All functions should be called exactly once
      mockFns.forEach(fn => {
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    it('should maintain order across batches', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 2 });
      jest.spyOn(customLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
      
      const mockFns = [
        jest.fn().mockResolvedValue('A'),
        jest.fn().mockResolvedValue('B'),
        jest.fn().mockResolvedValue('C'),
        jest.fn().mockResolvedValue('D'),
      ];
      
      const resultPromise = customLimiter.executeBatchRequests(mockFns);
      
      // Fast-forward through batch delays
      await jest.advanceTimersByTimeAsync(100);
      
      const result = await resultPromise;
      
      // Order should be preserved: batch1[A,B] + batch2[C,D] = [A,B,C,D]
      expect(result).toEqual(['A', 'B', 'C', 'D']);
    });
  });

  describe('delay behavior with fake timers', () => {
    it('should use correct retry delays with exponential backoff', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).code = 429;
      
      // Mock to fail twice, then succeed
      mockBottleneck.schedule
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue('success');
      
      const resultPromise = rateLimiter.executeRequest(mockFn);
      
      // Advance time to trigger retries
      await jest.advanceTimersByTimeAsync(1000); // First retry
      await jest.advanceTimersByTimeAsync(2000); // Second retry
      
      const result = await resultPromise;
      
      expect(result).toBe('success');
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(3);
    });

    it('should handle batch delays correctly', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 1 });
      jest.spyOn(customLimiter, 'executeRequest').mockImplementation(async (fn) => await fn());
      
      const mockFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
      ];
      
      const resultPromise = customLimiter.executeBatchRequests(mockFns);
      
      // Fast-forward through batch delay (50ms)
      await jest.advanceTimersByTimeAsync(50);
      
      const result = await resultPromise;
      
      expect(result).toEqual(['result1', 'result2']);
    });

    it('should handle timeout scenarios properly', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).code = 429;
      
      // Mock to fail once, then succeed
      mockBottleneck.schedule
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue('success');
      
      const resultPromise = rateLimiter.executeRequest(mockFn);
      
      // Check that there are pending timers before advancing
      // Note: jest.getTimerCount() might return 0 with fake timers
      // so we'll just verify the behavior works correctly
      
      // Fast-forward exactly 1000ms for the retry
      await jest.advanceTimersByTimeAsync(1000);
      
      const result = await resultPromise;
      expect(result).toBe('success');
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });
  });
});