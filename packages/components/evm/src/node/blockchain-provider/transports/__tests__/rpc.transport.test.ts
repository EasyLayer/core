import { NodeRpcTransport } from '../rpc.transport';

describe('NodeRpcTransport', () => {
  beforeEach(() => {
    (globalThis as any).fetch = jest.fn();
  });

  it('maps out-of-order batch responses by id and preserves nulls', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [
        { id: 2, result: 'second' },
        { id: 1, result: 'first' },
      ],
    });

    const transport = new NodeRpcTransport({
      uniqName: 'rpc-test',
      httpUrl: 'https://example.com',
      rateLimits: { minTimeMsBetweenRequests: 0 },
    });

    const results = await transport.batch<string>([
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_chainId', params: [] },
      { method: 'eth_syncing', params: [] },
    ]);

    expect(results).toEqual(['first', 'second', null]);
    await transport.close();
  });

  it('adds authorization header when url contains credentials', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [{ id: 1, result: '0x1' }],
    });

    const transport = new NodeRpcTransport({
      uniqName: 'rpc-auth',
      httpUrl: 'https://user:pass@example.com',
      rateLimits: { minTimeMsBetweenRequests: 0 },
    });

    await transport.request('eth_blockNumber');

    expect((globalThis as any).fetch).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Basic dXNlcjpwYXNz',
        }),
      })
    );

    await transport.close();
  });
});
