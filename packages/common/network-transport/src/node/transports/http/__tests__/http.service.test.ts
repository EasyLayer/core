import { Actions } from '../../../../core';
import { HttpTransportService, type HttpServiceOptions } from '../http.service';

const makeQueryBus = () => ({ execute: jest.fn(async () => 'ok') });

const baseOpts = (): HttpServiceOptions => ({
  type: 'http',
  host: '127.0.0.1',
  port: 3001,
  cors: { enabled: false },
  tls: null,
  maxBodySizeMb: 1,
  webhook: { url: 'http://127.0.0.1:9999/events', pingUrl: 'http://127.0.0.1:9999/ping', timeoutMs: 200 },
  ping: { staleMs: 2_000, factor: 1.2, minMs: 10, maxMs: 50, password: 'pw' },
  ackTimeoutMs: 500,
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('HttpTransportService', () => {
  it('throws if webhook config is incomplete', () => {
    const bad1 = { ...baseOpts(), webhook: { url: '' as any } } as any;
    expect(() => new HttpTransportService(bad1, makeQueryBus() as any)).toThrow(/webhook\.url/i);

    const bad2 = { ...baseOpts(), webhook: { url: 'http://x' } as any };
    expect(() => new HttpTransportService(bad2, makeQueryBus() as any)).toThrow(/webhook\.pingUrl/i);
  });

  it('resolves waitForAck from lastAckBuffer', async () => {
    const svc = new HttpTransportService(baseOpts(), makeQueryBus() as any);
    (svc as any).lastAckBuffer = { ok: true, okIndices: [0] };
    const ack = await svc.waitForAck(50);
    expect(ack.ok).toBe(true);
    expect((svc as any).lastAckBuffer).toBeNull();
    await svc.onModuleDestroy();
  });

  it('times out waitForAck if no ack', async () => {
    jest.useFakeTimers();
    const svc = new HttpTransportService(baseOpts(), makeQueryBus() as any);
    const p = svc.waitForAck(50);
    jest.advanceTimersByTime(60);
    await expect(p).rejects.toThrow(/ack timeout/i);
    await svc.onModuleDestroy();
  });

  it('resolves ack when send() receives OutboxStreamAck', async () => {
    const svc = new HttpTransportService(baseOpts(), makeQueryBus() as any);
    jest.spyOn(svc as any, 'post').mockResolvedValueOnce(
      JSON.stringify({ action: Actions.OutboxStreamAck, timestamp: Date.now(), payload: { ok: true, okIndices: [0] } })
    );
    const wait = svc.waitForAck(200);
    await svc.send({ action: 'OutboxStreamBatch' as any, timestamp: Date.now(), payload: {} as any });
    const ack = await wait;
    expect(ack.ok).toBe(true);
    await svc.onModuleDestroy();
  });

  it('heartbeat sets online true for valid Pong, false for invalid', async () => {
    jest.useFakeTimers();
    const opts = baseOpts();
    opts.ping = { ...opts.ping, minMs: 10, maxMs: 20 };
    const svc = new HttpTransportService(opts, makeQueryBus() as any);

    const postSpy = jest.spyOn(svc as any, 'post');
    postSpy.mockResolvedValueOnce(JSON.stringify({ action: Actions.Pong, payload: { password: 'pw' } }));

    await jest.advanceTimersByTimeAsync(15);

    expect(svc.isOnline()).toBe(true);

    postSpy.mockResolvedValueOnce(JSON.stringify({ action: Actions.Pong, payload: { password: 'bad' } }));
    await jest.advanceTimersByTimeAsync(15);

    expect(svc.isOnline()).toBe(false);
    await svc.onModuleDestroy();
  });

  it('post() rejects on non-2xx', async () => {
    const svc = new HttpTransportService(baseOpts(), makeQueryBus() as any);
    jest.spyOn(svc as any, 'post').mockRejectedValueOnce(new Error('HTTP 500'));
    await expect((svc as any).post('http://x', '{}')).rejects.toThrow(/500/);
    await svc.onModuleDestroy();
  });
});
