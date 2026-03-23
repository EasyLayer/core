import { RateLimiter } from '../rate-limiter';
import type { RateLimits } from '../interfaces';

// No Bottleneck mock needed — RateLimiter now uses its own internal Scheduler.
// Tests exercise the public API directly and verify observable behavior.

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  afterEach(async () => {
    if (rateLimiter) await rateLimiter.stop();
  });

  it('fills nulls when batchRpcCall returns fewer results than requested (single method group)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 3, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'm', params: [] },
      { method: 'm', params: [] },
      { method: 'm', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1']);
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', null, null]);
  });

  it('ignores extra results beyond batch length (single method group)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'm', params: [] },
      { method: 'm', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1', 'r2', 'r3', 'r4']);
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', 'r2']);
  });

  it('does not mutate input requests and preserves object identity passed to batch function', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2, minTimeMsBetweenRequests: 0 });
    const requestA = { method: 'm', params: [1] };
    const requestB = { method: 'm', params: [2] };
    const requests = [requestA, requestB];

    let receivedFirst: any;
    let receivedSecond: any;
    const mockBatchRpcCall = jest.fn().mockImplementation(async (calls) => {
      receivedFirst = calls[0];
      receivedSecond = calls[1];
      return ['ra', 'rb'];
    });

    const result = await rateLimiter.execute(requests, mockBatchRpcCall);

    expect(result).toEqual(['ra', 'rb']);
    expect(receivedFirst).toBe(requestA);   // same reference
    expect(receivedSecond).toBe(requestB);  // same reference
    expect(requests).toEqual([requestA, requestB]); // input not mutated
  });

  it('returns nulls when batch response is not an array', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2, minTimeMsBetweenRequests: 0 });
    const requests = [{ method: 'm', params: [] }];
    const mockBatchRpcCall = jest.fn().mockResolvedValue('not-an-array' as any);
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual([null]);
  });

  it('throws when maxBatchSize is zero', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 0 } as RateLimits);
    const requests = [{ method: 'm', params: [] }];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['ok']);
    await expect(rateLimiter.execute(requests, mockBatchRpcCall)).rejects.toThrow(
      'Batch size must be greater than 0'
    );
  });

  it('preserves order across multiple batches with partial failures (same method, batched)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'a', params: [] },
      { method: 'a', params: [] },
      { method: 'a', params: [] },
      { method: 'a', params: [] },
    ];
    const mockBatchRpcCall = jest
      .fn()
      .mockResolvedValueOnce([null, 'x'])
      .mockResolvedValueOnce([]);

    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual([null, 'x', null, null]);
  });

  it('returns empty array for empty input', async () => {
    rateLimiter = new RateLimiter({ minTimeMsBetweenRequests: 0 });
    const result = await rateLimiter.execute([], jest.fn());
    expect(result).toEqual([]);
  });

  it('groups requests by method into separate batches', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 10, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'a', params: [1] },
      { method: 'b', params: [2] },
      { method: 'a', params: [3] },
    ];

    const calls: any[][] = [];
    const mockBatchRpcCall = jest.fn().mockImplementation(async (batch) => {
      calls.push(batch.map((r: any) => r.params[0]));
      return batch.map(() => 'ok');
    });

    const result = await rateLimiter.execute(requests, mockBatchRpcCall);

    // Two batches: one for 'a' (indices 0,2), one for 'b' (index 1)
    expect(mockBatchRpcCall).toHaveBeenCalledTimes(2);
    // Results map back to original positions
    expect(result).toEqual(['ok', 'ok', 'ok']);
  });

  it('re-throws transport-level errors from batchRpcCall', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 5, minTimeMsBetweenRequests: 0 });
    const requests = [{ method: 'm', params: [] }];
    const transportError = new Error('connection refused');
    const mockBatchRpcCall = jest.fn().mockRejectedValue(transportError);

    await expect(rateLimiter.execute(requests, mockBatchRpcCall)).rejects.toThrow('connection refused');
  });

  it('getConfig returns effective config with applied defaults', () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 5 });
    const config = rateLimiter.getConfig();
    expect(config.maxBatchSize).toBe(5);
    expect(config.maxConcurrentRequests).toBe(1);
    expect(config.minTimeMsBetweenRequests).toBe(1000);
  });

  it('respects requestDelayMs as legacy alias when minTimeMsBetweenRequests is not set', () => {
    rateLimiter = new RateLimiter({ requestDelayMs: 500 });
    expect(rateLimiter.getConfig().minTimeMsBetweenRequests).toBe(500);
  });

  it('minTimeMsBetweenRequests takes precedence over requestDelayMs', () => {
    rateLimiter = new RateLimiter({ minTimeMsBetweenRequests: 200, requestDelayMs: 500 });
    expect(rateLimiter.getConfig().minTimeMsBetweenRequests).toBe(200);
  });

  it('stop() resolves without error', async () => {
    rateLimiter = new RateLimiter({ minTimeMsBetweenRequests: 0 });
    await expect(rateLimiter.stop()).resolves.toBeUndefined();
  });
});
