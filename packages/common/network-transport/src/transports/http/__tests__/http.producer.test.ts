import type { Envelope } from '../../../shared';
import { Actions } from '../../../shared';
import { HttpProducer } from '../http.producer';

const originalFetch = globalThis.fetch as any;

function mockFetchOk(json: any, status = 200) {
  globalThis.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  })) as any;
}

function mockFetchBodyThrows(status = 200) {
  globalThis.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error('bad json'); },
  })) as any;
}

function mockFetchStatus(status: number) {
  globalThis.fetch = jest.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as any;
}

describe('HttpProducer', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('resolves ACK when webhook returns JSON { allOk: true } and sends headers', async () => {
    mockFetchOk({ allOk: true, okIndices: [0, 1] });
    const p = new HttpProducer({
      name: 'http',
      endpoint: 'https://example.org/webhook',
      token: 'tok',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 500,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 500,
    });
    const envelope: Envelope = { action: Actions.OutboxStreamBatch, payload: { events: [] }, timestamp: Date.now() };

    const result = await p.waitForAck(async () => {
      await (p as any)._sendSerialized(envelope);
    });

    expect(result).toEqual({ allOk: true, okIndices: [0, 1] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://example.org/webhook');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['X-Transport-Token']).toBe('tok');
    expect(typeof init.body).toBe('string');
  });

  it('throws on non-2xx status', async () => {
    mockFetchStatus(500);
    const p = new HttpProducer({
      name: 'http',
      endpoint: 'https://x',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 200,
    });
    await expect(
      p.waitForAck(async () => {
        await (p as any)._sendSerialized({ action: 'a' });
      })
    ).rejects.toThrow('HTTP 500');
  });

  it('throws when webhook does not return JSON', async () => {
    mockFetchBodyThrows(200);
    const p = new HttpProducer({
      name: 'http',
      endpoint: 'https://x',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 200,
    });
    await expect(
      p.waitForAck(async () => {
        await (p as any)._sendSerialized({ action: 'a' });
      })
    ).rejects.toThrow('HTTP webhook did not return JSON ACK');
  });

  it('throws when webhook returns invalid ACK shape', async () => {
    mockFetchOk({ ok: true });
    const p = new HttpProducer({
      name: 'http',
      endpoint: 'https://x',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 200,
    });
    await expect(
      p.waitForAck(async () => {
        await (p as any)._sendSerialized({ action: 'a' });
      })
    ).rejects.toThrow('HTTP webhook returned invalid ACK');
  });
});
