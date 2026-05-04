import { RateLimiter } from '../rate-limiter';
import type { RateLimits } from '../../providers/interfaces';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  afterEach(async () => {
    if (rateLimiter) await rateLimiter.stop();
  });

  it('fills nulls when batchRpcCall returns fewer results than requested', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 3, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'eth_call', params: [] },
      { method: 'eth_call', params: [] },
      { method: 'eth_call', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1']);
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', null, null]);
  });

  it('ignores extra results beyond batch length', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 2, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'eth_call', params: [] },
      { method: 'eth_call', params: [] },
    ];
    const mockBatchRpcCall = jest.fn().mockResolvedValue(['r1', 'r2', 'r3']);
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);
    expect(result).toEqual(['r1', 'r2']);
  });

  it('preserves input order across grouped method batches', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 10, minTimeMsBetweenRequests: 0 });
    const requests = [
      { method: 'eth_getBlockByNumber', params: ['0x1'] },
      { method: 'eth_getLogs', params: [] },
      { method: 'eth_getBlockByNumber', params: ['0x2'] },
    ];

    const mockBatchRpcCall = jest.fn().mockImplementation(async (batch) => batch.map((item: any) => item.method));
    const result = await rateLimiter.execute(requests, mockBatchRpcCall);

    expect(mockBatchRpcCall).toHaveBeenCalledTimes(2);
    expect(result).toEqual(['eth_getBlockByNumber', 'eth_getLogs', 'eth_getBlockByNumber']);
  });

  it('throws when maxBatchSize is zero', async () => {
    rateLimiter = new RateLimiter({ maxBatchSize: 0 } as RateLimits);
    const requests = [{ method: 'eth_call', params: [] }];
    await expect(rateLimiter.execute(requests, jest.fn().mockResolvedValue(['ok']))).rejects.toThrow(
      'Batch size must be greater than 0'
    );
  });

  it('uses requestDelayMs as legacy alias', () => {
    rateLimiter = new RateLimiter({ requestDelayMs: 250 });
    expect(rateLimiter.getConfig().minTimeMsBetweenRequests).toBe(250);
  });
});
