import { Module, DynamicModule, OnModuleInit, Inject, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { createServer, Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { HttpController } from './http.controller';
import { HttpProducer, HttpProducerConfig } from './http.producer';

export interface HttpServerOptions {
  type: 'http';
  port?: number;
  host?: string;
  path?: string;
  streamPath?: string;
  maxMessageSize?: number;
  connectionTimeout?: number;
  token?: string;
  ssl?: {
    enabled: boolean;
    key?: string;
    cert?: string;
    ca?: string;
  };
  webhook?: {
    url: string;
    token?: string;
  };
}

class HttpServerManager implements OnModuleInit, OnModuleDestroy {
  private server!: HttpServer | HttpsServer;

  constructor(
    @Inject('HTTP_OPTIONS') private readonly options: HttpServerOptions,
    private readonly httpAdapterHost: HttpAdapterHost
  ) {}

  async onModuleInit() {
    const { port = 3000, host = '0.0.0.0', ssl } = this.options;
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) throw new Error('HttpAdapter not found');

    const app = httpAdapter.getInstance();

    if (ssl?.enabled && ssl.key && ssl.cert) {
      const httpsOptions = {
        key: readFileSync(ssl.key, 'utf8'),
        cert: readFileSync(ssl.cert, 'utf8'),
        ...(ssl.ca && { ca: readFileSync(ssl.ca, 'utf8') }),
      };
      this.server = createServer(httpsOptions, app);
      this.server.listen(port, host);
    } else {
      if (typeof app.listen === 'function') {
        this.server = app.listen(port, host);
      } else {
        this.server = createHttpServer(app);
        this.server.listen(port, host);
      }
      this.server.on('error', () => {});
    }
  }

  async onModuleDestroy() {
    await new Promise<void>((res) => this.server.close(() => res()));
  }
}

@Module({
  controllers: [HttpController],
  providers: [
    { provide: 'HTTP_OPTIONS', useValue: {} },
    {
      provide: HttpProducer,
      useFactory: (opts: HttpServerOptions) => {
        const cfg: HttpProducerConfig = {
          name: 'http',
          endpoint: opts.webhook?.url ?? '',
          token: opts.webhook?.token,
          maxMessageBytes: opts.maxMessageSize ?? 1024 * 1024,
          ackTimeoutMs: opts.connectionTimeout ?? 5000,
          heartbeatIntervalMs: 1000,
          heartbeatTimeoutMs: opts.connectionTimeout ?? 5000,
        };
        const producer = new HttpProducer(cfg);
        producer.startHeartbeat();
        return producer;
      },
      inject: ['HTTP_OPTIONS'],
    },
    { provide: 'HTTP_PRODUCER', useExisting: HttpProducer },
    HttpServerManager,
  ],
  exports: ['HTTP_OPTIONS', 'HTTP_PRODUCER'],
})
export class HttpTransportModule {
  static forRoot(options: HttpServerOptions): DynamicModule {
    return {
      module: HttpTransportModule,
      providers: [{ provide: 'HTTP_OPTIONS', useValue: options }],
      exports: ['HTTP_OPTIONS', 'HTTP_PRODUCER'],
    };
  }
}
