import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule, QueryBus } from '@easylayer/common/cqrs';
import { HttpTransportService } from '../http.service';

jest.mock('express', () => {
  return function () {
    const handlers: Record<string, any> = {};
    const app: any = (req: any, res: any) => app.handle(req, res);
    app.use = jest.fn();
    app.post = jest.fn((path: string, handler: any) => { handlers[path] = handler; });
    app.handle = (req: any, res: any) => { const h = handlers[req.url]; return h && h(req, res); };
    return app;
  };
});

jest.mock('body-parser', () => ({
  json: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('node:http', () => {
  const { EventEmitter } = require('events');
  return {
    request: (_opts: any, cb: any) => {
      let body = '';
      const res = new EventEmitter();
      const req = new EventEmitter() as any;
      req.on = req.on.bind(req);
      req.write = (chunk: any) => { body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); };
      req.end = () => {
        process.nextTick(() => {
          cb(res);
          let parsed: any;
          try { parsed = JSON.parse(body); } catch {}
          if (parsed?.action === 'outbox.stream.batch') {
            res.emit('data', Buffer.from(JSON.stringify({ action: 'outbox.stream.ack', payload: { ok: true, okIndices: [0] } })));
          } else {
            res.emit('data', Buffer.from(JSON.stringify({ action: 'pong', payload: { password: 'pw' } })));
          }
          res.emit('end');
        });
      };
      req.setTimeout = jest.fn();
      return req;
    },
    createServer: (_handler: any) => {
      const { EventEmitter } = require('events');
      const srv = new EventEmitter() as any;
      srv.listen = jest.fn();
      srv.close = (cb?: any) => { cb && cb(); };
      return srv;
    },
  };
});

jest.mock('node:https', () => jest.requireMock('node:http'));

describe('HttpTransportService', () => {
  let modRef: TestingModule | undefined;
    
  afterEach(async () => {
    try { await modRef?.close(); } catch {}
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('goes online after pong with correct password', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: HttpTransportService,
          useFactory: (qb: QueryBus) =>
            new HttpTransportService(
              {
                type: 'http',
                host: '127.0.0.1',
                port: 32000,
                tls: null,
                webhook: { url: 'http://localhost:9/hook' },
                ping: { password: 'pw', minMs: 10, factor: 1.1, maxMs: 20 },
              },
              qb
            ),
          inject: [QueryBus],
        },
      ],
    }).compile();

    const svc = modRef.get(HttpTransportService);
    await svc.send({ action: 'ping', timestamp: Date.now() } as any);
    await svc.waitForOnline(500);
    expect(svc.isOnline()).toBe(true);
  });

  it('resolves ACK for batch', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: HttpTransportService,
          useFactory: (qb: QueryBus) =>
            new HttpTransportService(
              { type: 'http', host: '127.0.0.1', port: 32001, tls: null, webhook: { url: 'http://localhost:9/hook' } },
              qb
            ),
          inject: [QueryBus],
        },
      ],
    }).compile();
    const svc = modRef.get(HttpTransportService);
    const p = svc.waitForAck(500);
    await svc.send({ action: 'outbox.stream.batch', payload: { events: [] }, timestamp: Date.now() } as any);
    const ack = await p;
    expect(ack).toEqual({ ok: true, okIndices: [0] });
  });

  it('executes POST /query and returns response payload', async () => {
    const exec = jest.fn(async (q) => ({ ok: true, echo: q }));
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: HttpTransportService,
          useFactory: () =>
            new HttpTransportService(
              { type: 'http', host: '127.0.0.1', port: 32002, tls: null },
              { execute: exec } as any
            ),
        },
      ],
    }).compile();
    const svc = modRef.get(HttpTransportService) as any;
    const app = (svc as any).app;
    const req: any = { method: 'POST', url: '/query', body: { name: 'Q', data: 1 }, headers: {} };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await app.handle(req, res);
    expect(exec).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
