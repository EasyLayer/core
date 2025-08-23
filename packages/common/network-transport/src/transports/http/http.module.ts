import { Module, DynamicModule, OnModuleInit, Inject, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { createServer, Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { RpcController } from './rpc.controller';
// import { StreamController } from './stream.controller';
import { HttpWebhookProducer } from './http.producer';

export interface HttpServerOptions {
  type: 'http';
  port?: number;
  host?: string;
  path?: string; // REST/RPC base path (handled by Nest)
  streamPath?: string; // if you expose a stream endpoint on server (optional)
  maxMessageSize?: number;
  connectionTimeout?: number;
  token?: string; // optional X-Transport-Token for server-side auth
  ssl?: {
    enabled: boolean;
    key?: string;
    cert?: string;
    ca?: string;
  };
  // outgoing webhook config for HttpWebhookProducer
  webhook?: {
    url: string; // where to POST outbox batches
    token?: string; // optional X-Transport-Token for receiver
  };
}

class HttpServerManager implements OnModuleInit, OnModuleDestroy {
  private server!: HttpServer | HttpsServer;

  constructor(
    @Inject('HTTP_OPTIONS')
    private readonly options: HttpServerOptions,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logger: AppLogger
  ) {}

  async onModuleInit() {
    const { port = 3000, host = '0.0.0.0', ssl } = this.options;

    // Get the underlying HTTP server from NestJS
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) {
      throw new Error('HttpAdapter not found. Run the app via NestFactory.create() or provide your own adapter.');
    }

    const app = httpAdapter.getInstance();

    if (ssl?.enabled && ssl.key && ssl.cert) {
      try {
        const httpsOptions = {
          key: readFileSync(ssl.key, 'utf8'),
          cert: readFileSync(ssl.cert, 'utf8'),
          ...(ssl.ca && { ca: readFileSync(ssl.ca, 'utf8') }),
        };
        this.server = createServer(httpsOptions, app);
        this.server.listen(port, host, () => this.logger.info(`HTTPS server listening on ${host}:${port}`));
      } catch (sslError) {
        this.logger.error('Failed to start HTTPS server:', { args: { sslError } });
        throw sslError;
      }
    } else {
      // Start regular HTTP server (Nest binds its handler to this server)
      this.server = app.listen(port, host, () => this.logger.info(`HTTP server listening on ${host}:${port}`));
      this.server.on('error', (err) => {
        this.logger.error('HTTP(S) server error', { args: { err } });
      });
    }
  }

  async onModuleDestroy() {
    await new Promise<void>((res) => this.server.close(() => res()));
    this.logger.info('HTTP server closed');
  }
}

@Module({
  imports: [LoggerModule.forRoot({ componentName: 'HttpTransportModule' })],
  controllers: [RpcController], //StreamController
  providers: [
    { provide: 'HTTP_OPTIONS', useValue: {} },

    // HttpWebhookProducer factory: provides outgoing webhook for outbox streaming
    {
      provide: HttpWebhookProducer,
      useFactory: (logger: AppLogger, opts: HttpServerOptions) => {
        // If webhook config is missing, producer can still exist (but will throw on send)
        return new HttpWebhookProducer(logger, {
          name: 'http',
          endpoint: opts.webhook?.url ?? '',
          maxMessageBytes: opts.maxMessageSize ?? 1024 * 1024,
          ackTimeoutMs: opts.connectionTimeout ?? 5000,
          heartbeatMs: 1000, // not really used for HTTP
          heartbeatTimeoutMs: opts.connectionTimeout ?? 5000,
          token: opts.webhook?.token,
        });
      },
      inject: [AppLogger, 'HTTP_OPTIONS'],
    },
    { provide: 'HTTP_PRODUCER', useExisting: HttpWebhookProducer },

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
