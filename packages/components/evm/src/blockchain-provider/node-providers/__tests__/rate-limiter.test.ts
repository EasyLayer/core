import { RateLimiter, DEFAULT_RATE_LIMITS } from '../rate-limiter';

jest.mock('bottleneck');

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  let mockBottleneck: any;

  beforeEach(() => {
    jest.useFakeTimers({ advanceTimers: true });
    jest.clearAllMocks();
    
    mockBottleneck = {
      schedule: jest.fn(),
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

  describe('executeRequest', () => {
    it('should execute request through Bottleneck', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');
      mockBottleneck.schedule.mockResolvedValue('success');
      
      const result = await rateLimiter.executeRequest(mockFn);
      
      expect(result).toBe('success');
      expect(mockBottleneck.schedule).toHaveBeenCalledWith(mockFn);
    });

    it('should propagate errors without retry', async () => {
      const mockFn = jest.fn();
      const error = new Error('Network error');
      mockBottleneck.schedule.mockRejectedValue(error);
      
      await expect(rateLimiter.executeRequest(mockFn)).rejects.toThrow('Network error');
    });
  });

  describe('executeParallelRequests', () => {
    it('should execute multiple requests in parallel', async () => {
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeParallelRequests(requestFns);
      
      expect(result).toEqual(['result1', 'result2']);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });

    it('should return empty array for empty input', async () => {
      const result = await rateLimiter.executeParallelRequests([]);
      expect(result).toEqual([]);
    });
  });

  describe('executeBatchRequests', () => {
    it('should execute single batch', async () => {
      const items = ['item1', 'item2'];
      const batchRequestFn = jest.fn().mockResolvedValue(['result1', 'result2']);
      
      const result = await rateLimiter.executeBatchRequests(items, batchRequestFn);
      
      expect(result).toEqual(['result1', 'result2']);
      expect(batchRequestFn).toHaveBeenCalledWith(['item1', 'item2']);
    });

    it('should split into multiple batches with delay', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 1, batchDelayMs: 200 });
      const items = ['item1', 'item2'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['result1'])
        .mockResolvedValueOnce(['result2']);
      
      const promise = customLimiter.executeBatchRequests(items, batchRequestFn);
      
      // First batch should execute immediately
      await Promise.resolve();
      expect(batchRequestFn).toHaveBeenCalledTimes(1);
      
      // Advance through delay
      jest.advanceTimersByTime(200);
      const result = await promise;
      
      expect(result).toEqual(['result1', 'result2']);
      expect(batchRequestFn).toHaveBeenCalledTimes(2);
    });

    it('should detect rate limit errors', async () => {
      const items = ['item1'];
      const rateLimitError = new Error('Too many requests');
      (rateLimitError as any).code = 429;
      
      const batchRequestFn = jest.fn().mockRejectedValue(rateLimitError);
      
      await expect(rateLimiter.executeBatchRequests(items, batchRequestFn)).rejects.toThrow('Rate limit exceeded');
    });

    it('should return empty array for empty input', async () => {
      const result = await rateLimiter.executeBatchRequests([], jest.fn());
      expect(result).toEqual([]);
    });

    it('should not delay when batchDelayMs is 0', async () => {
      const customLimiter = new RateLimiter({ maxBatchSize: 1, batchDelayMs: 0 });
      const items = ['item1', 'item2'];
      
      const batchRequestFn = jest.fn()
        .mockResolvedValueOnce(['result1'])
        .mockResolvedValueOnce(['result2']);
      
      const result = await customLimiter.executeBatchRequests(items, batchRequestFn);
      
      expect(result).toEqual(['result1', 'result2']);
      expect(batchRequestFn).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('executeSequentialRequests', () => {
    it('should execute requests sequentially', async () => {
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      const result = await rateLimiter.executeSequentialRequests(requestFns);
      
      expect(result).toEqual(['result1', 'result2']);
      expect(mockBottleneck.schedule).toHaveBeenCalledTimes(2);
    });

    it('should stop on error', async () => {
      const requestFns = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockRejectedValue(new Error('Error')),
        jest.fn().mockResolvedValue('result3'),
      ];
      
      mockBottleneck.schedule.mockImplementation(async (fn: any) => await fn());
      
      await expect(rateLimiter.executeSequentialRequests(requestFns)).rejects.toThrow('Error');
      expect(requestFns[2]).not.toHaveBeenCalled();
    });

    it('should return empty array for empty input', async () => {
      const result = await rateLimiter.executeSequentialRequests([]);
      expect(result).toEqual([]);
    });
  });

  describe('rate limit error detection', () => {
    it('should detect rate limit errors by code', async () => {
      const codes = [429, -32007, -32005, -32000];
      
      for (const code of codes) {
        const error = new Error('Error');
        (error as any).code = code;
        const batchRequestFn = jest.fn().mockRejectedValue(error);
        
        await expect(rateLimiter.executeBatchRequests(['item'], batchRequestFn)).rejects.toThrow('Rate limit exceeded');
      }
    });

    it('should detect rate limit errors by message', async () => {
      const messages = ['rate limit', 'too many requests', 'quota exceeded'];
      
      for (const message of messages) {
        const error = new Error(message);
        const batchRequestFn = jest.fn().mockRejectedValue(error);
        
        await expect(rateLimiter.executeBatchRequests(['item'], batchRequestFn)).rejects.toThrow('Rate limit exceeded');
      }
    });

    it('should not enhance non-rate-limit errors', async () => {
      const error = new Error('Network timeout');
      const batchRequestFn = jest.fn().mockRejectedValue(error);
      
      await expect(rateLimiter.executeBatchRequests(['item'], batchRequestFn)).rejects.toThrow('Network timeout');
    });
  });

  describe('configuration', () => {
    it('should use default configuration', () => {
      const limiter = new RateLimiter();
      expect(limiter.getStats()).toEqual(DEFAULT_RATE_LIMITS);
    });

    it('should merge custom config with defaults', () => {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 20 });
      const stats = limiter.getStats();
      
      expect(stats.maxRequestsPerSecond).toBe(20);
      expect(stats.maxConcurrentRequests).toBe(DEFAULT_RATE_LIMITS.maxConcurrentRequests);
    });

    it('should update configuration', () => {
      rateLimiter.updateConfig({ maxRequestsPerSecond: 30 });
      expect(rateLimiter.getStats().maxRequestsPerSecond).toBe(30);
    });

    it('should stop Bottleneck on reset', () => {
      const stopSpy = jest.spyOn(mockBottleneck, 'stop');
      rateLimiter.reset();
      expect(stopSpy).toHaveBeenCalled();
    });
  });
});