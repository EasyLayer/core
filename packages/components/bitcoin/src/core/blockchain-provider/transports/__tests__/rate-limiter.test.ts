jest.mock('bottleneck', () => {
  const schedule = jest.fn();
  const stop = jest.fn().mockResolvedValue(undefined);
  const Ctor = jest.fn().mockImplementation(() => ({ schedule, stop }));
  return { __esModule: true, default: Ctor };
});

import Bottleneck from 'bottleneck';
import { RateLimiter } from '../rate-limiter';
import type { RateLimits } from '../interfaces';

const ctor = Bottleneck as unknown as jest.Mock;
const inst = () => (ctor.mock.results[ctor.mock.results.length - 1]?.value ?? {}) as { schedule: jest.Mock };

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  afterEach(async () => {
    if (rateLimiter) await rateLimiter.stop();
    jest.clearAllMocks();
  });

  it('fills nulls when batchRpcCall returns fewer results than requested (single method group)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 3 });
    inst().schedule.mockImplementation(async (fn: any) => fn());
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
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    inst().schedule.mockImplementation(async (fn: any) => fn());
    const requests = [
      { method: 'm', params: [] },
      { method: 'm', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1', 'r2', 'r3', 'r4']);
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', 'r2']);
  });

  it('does not mutate input requests and preserves object identity passed to batch function (single batch)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    inst().schedule.mockImplementation(async (fn: any) => fn());
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
    expect(receivedFirst).toBe(requestA);
    expect(receivedSecond).toBe(requestB);
    expect(requests).toEqual([requestA, requestB]);
  });

  it('returns nulls when batch response is not an array (single method group)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    inst().schedule.mockImplementation(async (fn: any) => fn());
    const requests = [{ method: 'm', params: [] }];
    const mockBatchRpcCall = jest.fn().mockResolvedValue('not-an-array' as any);
    const out = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(out).toEqual([null]);
  });

  it('throws when maxBatchSize is zero', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 0 } as RateLimits);
    const requests = [{ method: 'm', params: [] }];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['ok']);
    await expect(rateLimiter.execute(requests, mockBatchRpcCall)).rejects.toThrow('Batch size must be greater than 0');
  });

  it('preserves order across multiple batches with partial failures (same method, batched)', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    inst().schedule.mockImplementation(async (fn: any) => fn());
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
});
