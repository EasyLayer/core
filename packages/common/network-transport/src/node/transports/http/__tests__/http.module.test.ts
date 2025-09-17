import { Test } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import { CqrsModule} from '@easylayer/common/cqrs';
import { HttpTransportModule, HttpServerOptions } from '../http.module';
import { HttpController } from '../http.controller';
import { HttpProducer } from '../http.producer';

const makeServer = () => {
  const handlers: Record<string, Function[]> = {};
  return {
    listen: jest.fn((_port?: number, _host?: string) => ({})),
    close: jest.fn((cb?: Function) => cb && cb()),
    on: jest.fn((evt: string, cb: Function) => {
      handlers[evt] = handlers[evt] || [];
      handlers[evt]?.push(cb);
    }),
    emit: (evt: string, ...args: any[]) => (handlers[evt] || []).forEach((f) => f(...args)),
  };
};

describe('HttpTransportModule', () => {
  it('wires providers, options, and maps producer config (non-SSL path)', async () => {
    const options: HttpServerOptions = {
      type: 'http',
      port: 3456,
      host: '127.0.0.1',
      connectionTimeout: 7000,
      maxMessageSize: 512 * 1024,
      webhook: { url: 'https://example.org/hook', token: 'tok' },
    };

    const server = makeServer();
    const httpAdapterHost = {
      httpAdapter: {
        getInstance: () => ({
          listen: jest.fn((_p: number, _h: string) => server),
        }),
      },
    };

    const moduleRef = await Test.createTestingModule({
        imports: [
            HttpTransportModule.forRoot(options),
            CqrsModule.forRoot({isGlobal: true})
        ],
    })
      .overrideProvider('HTTP_OPTIONS')
      .useValue(options)
      .overrideProvider((HttpTransportModule as any).providers?.HttpServerManager ?? 'HttpServerManager')
      .useValue({})
      .overrideProvider(HttpAdapterHost)
      .useValue(httpAdapterHost)
      .compile();

    const controller = moduleRef.get(HttpController);
    expect(controller).toBeInstanceOf(HttpController);

    const producer = moduleRef.get(HttpProducer);
    const alias = moduleRef.get('HTTP_PRODUCER');
    const opts = moduleRef.get('HTTP_OPTIONS');
    expect(producer).toBeInstanceOf(HttpProducer);
    expect(alias).toBe(producer);
    expect(opts).toEqual(options);

    const cfg = (producer as any).configuration;
    expect(cfg.name).toBe('http');
    expect(cfg.maxMessageBytes).toBe(options.maxMessageSize);
    expect(cfg.ackTimeoutMs).toBe(options.connectionTimeout);
    expect(cfg.heartbeatTimeoutMs).toBe(options.connectionTimeout);
    expect(cfg.heartbeatIntervalMs).toBe(1000);
  });
});
