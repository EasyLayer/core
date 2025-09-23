import { Test, type TestingModule } from '@nestjs/testing';
import { CqrsModule, QueryBus } from '@easylayer/common/cqrs';
import { WsTransportService } from '../ws.service';

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class MockSocket extends EventEmitter {
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;
    send = jest.fn((data: any, cb: any) => cb && cb());
    close = jest.fn();
  }
  class MockWSS extends EventEmitter {
    clients = new Set<MockSocket>();
    close = jest.fn();
    addClient() {
      const c = new MockSocket();
      this.clients.add(c);
      this.emit('connection', c);
      return c;
    }
  }
  return { WebSocketServer: MockWSS, WebSocket: MockSocket };
});

jest.mock('node:http', () => ({ createServer: () => ({ listen: jest.fn(), close: (cb: any) => cb && cb() }) }));
jest.mock('node:https', () => jest.requireMock('node:http'));

const tick = () => new Promise(res => setTimeout(res, 0));

describe('WsTransportService', () => {
  let modRef: TestingModule | undefined;

  afterEach(async () => {
    try { await modRef?.close(); } catch {}
    jest.clearAllTimers();
    jest.useRealTimers();
    modRef = undefined;
  });

  it('accepts single client and goes online after pong with correct password', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: WsTransportService,
          useFactory: (qb: QueryBus) => new WsTransportService(
            { type: 'ws', host: '127.0.0.1', port: 43000, password: 'pw', ping: { minMs: 10, factor: 1.1, maxMs: 20 } },
            qb
          ),
          inject: [QueryBus],
        },
      ],
    }).compile();

    const svc = modRef.get(WsTransportService) as any;
    const wss: any = svc.wss;
    const socket = wss.addClient();
    await tick();
    socket.emit('message', JSON.stringify({ action: 'pong', payload: { password: 'pw' } }));
    await svc.waitForOnline(500);
    expect(svc.isOnline()).toBe(true);
  });

  it('routes QueryRequest to QueryBus and replies on the same socket', async () => {
    const exec = jest.fn(async () => ({ ok: true }));
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: WsTransportService,
          useFactory: () =>
            new WsTransportService(
              { type: 'ws', host: '127.0.0.1', port: 43001, password: 'pw', ping: { minMs: 10, factor: 1.1, maxMs: 20 } } as any,
              { execute: exec } as any
            ),
        },
      ],
    }).compile();

    const svc = modRef.get(WsTransportService) as any;
    const wss: any = svc.wss;
    const socket = wss.addClient();
    await tick();
    socket.emit('message', JSON.stringify({ action: 'pong', payload: { password: 'pw' } }));
    await svc.waitForOnline(500);

    (socket.send as jest.Mock).mockClear();
    socket.emit('message', JSON.stringify({ action: 'query.request', payload: { name: 'Q', data: 1 }, requestId: 'r1' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(exec).toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
  });

  it('keeps only the latest client', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: WsTransportService,
          useFactory: (qb: QueryBus) => new WsTransportService(
            { type: 'ws', host: '127.0.0.1', port: 43002, password: 'pw', ping: { minMs: 10, factor: 1.1, maxMs: 20 } },
            qb
          ),
          inject: [QueryBus],
        },
      ],
    }).compile();

    const svc = modRef.get(WsTransportService) as any;
    const wss: any = svc.wss;

    const first = wss.addClient();
    await tick();
    const second = wss.addClient();
    await tick();

    second.emit('message', JSON.stringify({ action: 'pong', payload: { password: 'pw' } }));
    await svc.waitForOnline(500);

    (first.send as jest.Mock).mockClear();
    (second.send as jest.Mock).mockClear();

    second.emit('message', JSON.stringify({ action: 'query.request', payload: { name: 'Q', data: 1 }, requestId: 'r2' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(second.send).toHaveBeenCalled();
    expect(first.send).not.toHaveBeenCalled();
  });

  it('resolves ACK for batch', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: WsTransportService,
          useFactory: (qb: QueryBus) => new WsTransportService(
            { type: 'ws', host: '127.0.0.1', port: 43003, password: 'pw', ping: { minMs: 10, factor: 1.1, maxMs: 20 } },
            qb
          ),
          inject: [QueryBus],
        },
      ],
    }).compile();

    const svc = modRef.get(WsTransportService) as any;
    const wss: any = svc.wss;
    const socket = wss.addClient();
    await tick();
    socket.emit('message', JSON.stringify({ action: 'pong', payload: { password: 'pw' } }));
    await svc.waitForOnline(500);

    const wait = svc.waitForAck(300);
    socket.emit('message', JSON.stringify({ action: 'outbox.stream.ack', payload: { ok: true, okIndices: [0] } }));
    await expect(wait).resolves.toEqual({ ok: true, okIndices: [0] });
  });
});
