jest.mock('http', () => ({
  createServer: () => ({
    on: (_e: string, _cb: Function) => undefined,
    listen: (_p?: any, _h?: any, cb?: any) => { cb && cb(); },
    close: (cb?: any) => { cb && cb(); },
  }),
}));
jest.mock('https', () => jest.requireMock('http'));
jest.mock('node:http', () => jest.requireMock('http'));
jest.mock('node:https', () => jest.requireMock('https'));

jest.mock('ws', () => {
  class E {
    m = new Map<string, Function[]>();
    on(ev: string, fn: Function) { (this.m.get(ev) ?? this.m.set(ev, []).get(ev)!)!.push(fn); }
    emit(ev: string, ...a: any[]) { (this.m.get(ev) || []).forEach(f => f(...a)); }
  }
  class WSS extends E {
    clients = new Set<any>();
    constructor(_opts: any) { super(); }
    close = jest.fn();
  }
  class WS extends E {
    static OPEN = 1;
    readyState = 1;
    send = jest.fn((_d: any, cb?: Function) => { cb && cb(); });
    close = jest.fn();
  }
  return { WebSocketServer: WSS, WebSocket: WS };
});

jest.mock('@easylayer/common/exponential-interval-async', () => ({
  exponentialIntervalAsync: (fn: (reset: () => void) => any) => { const r = () => {}; fn(r); return { destroy: () => {} }; },
}));

import { Actions } from '../../../../core';
import { WsTransportService, type WsServiceOptions } from '../ws.service';
import type { QueryBus } from '@easylayer/common/cqrs';

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  send = jest.fn((data: any, cb?: (err?: any) => void) => { this.sent.push(String(data)); cb && cb(); });
  close = jest.fn();
  on = jest.fn();
}

const baseOpts = (port: number): WsServiceOptions => ({
  type: 'ws',
  host: '127.0.0.1',
  port,
  path: '/ws',
  tls: null,
  ackTimeoutMs: 200,
  maxWireBytes: 1024 * 1024,
  ping: { staleMs: 1000, factor: 1.2, minMs: 50, maxMs: 100, password: 'pw' },
});

const makeQB = (): QueryBus =>
  ({ execute: jest.fn(async (q: any) => ({ ok: true, name: q?.name, dto: q?.dto })) } as unknown as QueryBus);

jest.setTimeout(15000);

describe('WsTransportService minimal unit', () => {
  let svc: WsTransportService | undefined;

  afterEach(async () => {
    if (svc) await svc.onModuleDestroy();
    svc = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('isOnline works with flags set', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    const sock = new FakeSocket();
    (svc as any).socket = sock;
    (svc as any).online = true;
    (svc as any).lastPongAt = Date.now();
    expect(svc.isOnline()).toBe(true);
    (svc as any).online = false;
    expect(svc.isOnline()).toBe(false);
  });

  it('waitForOnline resolves when online is pre-set', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    const sock = new FakeSocket();
    (svc as any).socket = sock;
    (svc as any).online = true;
    (svc as any).lastPongAt = Date.now();
    await expect(svc.waitForOnline(200)).resolves.toBeUndefined();
  });

  it('send throws without client', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    await expect(svc.send({ action: 'X' as any, timestamp: Date.now() } as any)).rejects.toThrow(/no active client/i);
  });

  it('send writes when client set', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    const sock = new FakeSocket();
    (svc as any).socket = sock;
    await svc.send({ action: 'Ping' as any, timestamp: Date.now() } as any);
    expect(sock.send).toHaveBeenCalledTimes(1);
  });

  it('waitForAck resolves from buffer', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    (svc as any).lastAckBuffer = { ok: true, okIndices: [0] };
    const got = await svc.waitForAck(200);
    expect(got.ok).toBe(true);
    expect(got.okIndices).toEqual([0]);
  });

  it('waitForAck times out', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    jest.useFakeTimers();
    const p = svc.waitForAck(100);
    jest.advanceTimersByTime(120);
    await expect(p).rejects.toThrow(/ack timeout/i);
  });

  it('handleQuery sends success response', async () => {
    svc = new WsTransportService(baseOpts(1), makeQB());
    const sock = new FakeSocket();
    (svc as any).socket = sock;

    await (svc as any).handleQuery('Echo', { a: 1 });

    expect(sock.sent.length).toBeGreaterThan(0);
    const last = JSON.parse(sock.sent.at(-1)!);
    expect(last.action).toBe(Actions.QueryResponse);
    expect(last.payload.ok).toBe(true);
  });

  it('handleQuery sends error response', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    const sock = new FakeSocket();
    (svc as any).socket = sock;
    await (svc as any).handleQuery(0 as any, {});
    const last = JSON.parse(sock.sent.at(-1)!);
    expect(last.action).toBe(Actions.QueryResponse);
    expect(last.payload.ok).toBe(false);
  });

  it('onClose rejects pending ACK', async () => {
    svc = new WsTransportService(baseOpts(3001), makeQB());
    const sock = new FakeSocket();
    (svc as any).socket = sock;
    const p = svc.waitForAck(500);
    (svc as any).onClose(1000, 'closed');
    await expect(p).rejects.toThrow(/closed/i);
  });
});
