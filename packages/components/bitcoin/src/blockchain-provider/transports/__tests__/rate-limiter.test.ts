import { RateLimiter } from '../rate-limiter';
import type { RateLimits } from '../interfaces';

jest.mock('bottleneck');
import Bottleneck from 'bottleneck';

const MockBottleneck = Bottleneck as jest.MockedClass<typeof Bottleneck>;

describe('RateLimiter invariants', () => {
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

  it('fills nulls when batchRpcCall returns fewer results than requested', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 3 });
    const requests = [
      { method: 'm1', params: [] },
      { method: 'm2', params: [] },
      { method: 'm3', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1']);
    mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', null, null]);
  });

  it('ignores extra results beyond batch length', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    const requests = [
      { method: 'm1', params: [] },
      { method: 'm2', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1', 'r2', 'r3', 'r4']);
    mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', 'r2']);
  });

  it('does not mutate input requests and preserves object identity passed to batch function', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    const requestA = { method: 'ma', params: [1] };
    const requestB = { method: 'mb', params: [2] };
    const requests = [requestA, requestB];
    let receivedFirst: any;
    let receivedSecond: any;
    const mockBatchRpcCall = jest.fn().mockImplementation(async (calls) => {
      receivedFirst = calls[0];
      receivedSecond = calls[1];
      return ['ra', 'rb'];
    });
    mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['ra', 'rb']);
    expect(receivedFirst).toBe(requestA);
    expect(receivedSecond).toBe(requestB);
    expect(requests).toEqual([requestA, requestB]);
  });

  it('throws on invalid non-array batch response', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    const requests = [{ method: 'm', params: [] }];
    const mockBatchRpcCall = jest.fn().mockResolvedValue('not-an-array' as any);
    mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());
    await expect(rateLimiter.execute(requests, mockBatchRpcCall)).rejects.toThrow('Invalid batch response: expected array');
  });

  it('throws when maxBatchSize is zero', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 0 } as RateLimits);
    const requests = [{ method: 'm', params: [] }];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['ok']);
    await expect(rateLimiter.execute(requests, mockBatchRpcCall)).rejects.toThrow('Batch size must be greater than 0');
  });

  it('preserves order across multiple batches with partial failures', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2 });
    const requests = [
      { method: 'a', params: [] },
      { method: 'b', params: [] },
      { method: 'c', params: [] },
      { method: 'd', params: [] },
    ];
    const mockBatchRpcCall = jest
      .fn()
      .mockResolvedValueOnce([null, 'x'])
      .mockResolvedValueOnce([]);
    mockBottleneckInstance.schedule.mockImplementation((fn: any) => fn());
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual([null, 'x', null, null]);
  });
});
