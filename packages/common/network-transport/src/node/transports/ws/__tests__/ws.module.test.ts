import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { CqrsModule } from '@easylayer/common/cqrs';
import type { WsServerOptions } from '../ws.module';
import { WsTransportModule } from '../ws.module';
import { WsProducer } from '../ws.producer';
import { WsGateway } from '../ws.gateway';

const socketIoCtorCalls: any[] = [];

jest.mock('node:http', () => {
  const handlers: Record<string, Function[]> = {};
  const serverStub = {
    listen: jest.fn((_port?: number, _host?: string) => ({})),
    close: jest.fn((cb?: Function) => { if (cb) cb(); }),
    on: jest.fn((evt: string, cb: Function) => {
      handlers[evt] = handlers[evt] || [];
      handlers[evt]!.push(cb);
    }),
    emit: (evt: string, ...args: any[]) => (handlers[evt] || []).forEach((f) => f(...args)),
  };
  return {
    createServer: jest.fn(() => serverStub),
    Server: class {},
  };
});

jest.mock('socket.io', () => {
  class MockSocketIOServer {
    public sockets = { sockets: new Map<string, any>() };
    public on = jest.fn();
    public close = jest.fn();
    constructor(httpServer: any, opts: any) {
      socketIoCtorCalls.push({ httpServer, opts });
    }
  }
  return { Server: MockSocketIOServer };
});

const timers: NodeJS.Timeout[] = [];
jest.mock('@easylayer/common/exponential-interval-async', () => ({
  exponentialIntervalAsync: (fn: (reset: () => void) => Promise<void>) => {
    const t = setTimeout(() => { fn(() => {}); }, 0);
    timers.push(t);
    return { destroy: () => clearTimeout(t) };
  },
}));

describe('WsTransportModule', () => {
  it('wires providers, config and starts WS (non-SSL)', async () => {
    const options: WsServerOptions = {
      type: 'ws',
      port: 3010,
      host: '127.0.0.1',
      path: '/socket',
      maxMessageSize: 256 * 1024,
      heartbeatTimeout: 9000,
      connectionTimeout: 7000,
      token: 'tok',
      transports: ['websocket'],
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        WsTransportModule.forRoot(options),
        CqrsModule.forRoot({ isGlobal: true }),
      ],
    })
      .overrideProvider('WS_OPTIONS')
      .useValue(options)
      .compile();

    await moduleRef.init();

    try {
      const producer = moduleRef.get(WsProducer);
      const alias = moduleRef.get('WS_PRODUCER');
      const gateway = moduleRef.get(WsGateway);

      expect(producer).toBeInstanceOf(WsProducer);
      expect(alias).toBe(producer);
      expect(gateway).toBeInstanceOf(WsGateway);

      const cfg = (producer as any).configuration;
      expect(cfg.name).toBe('ws');
      expect(cfg.maxMessageBytes).toBe(options.maxMessageSize);
      expect(cfg.ackTimeoutMs).toBe(options.connectionTimeout);
      expect(cfg.heartbeatTimeoutMs).toBe(options.heartbeatTimeout);
      expect(cfg.heartbeatIntervalMs).toBe(Math.max(500, Math.floor((options.heartbeatTimeout as number) / 2)));

      expect(socketIoCtorCalls.length).toBe(1);
      const { opts } = socketIoCtorCalls[0];
      expect(opts.path).toBe('/socket');
      expect(opts.maxHttpBufferSize).toBe(256 * 1024);
      expect(opts.transports).toEqual(['websocket']);
    } finally {
      const prod = moduleRef.get(WsProducer, { strict: false });
      if (prod?.stopHeartbeat) prod.stopHeartbeat();
      while (timers.length) {
        const t = timers.pop();
        if (t) clearTimeout(t);
      }
      await moduleRef.close();
      await new Promise((r) => setImmediate(r));
    }
  });
});
