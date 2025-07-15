import { Module, DynamicModule, OnModuleInit, Inject } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { RpcController } from './rpc.controller';
import { StreamController } from './stream.controller';

export interface HttpServerOptions {
  type: 'http';
  port?: number;
  host?: string;
  path?: string;
  streamPath?: string;
  maxMessageSize?: number;
  connectionTimeout?: number;
  ssl?: {
    enabled: boolean;
    key?: string;
    cert?: string;
    ca?: string;
  };
}

class HttpServerManager implements OnModuleInit {
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
      throw new Error(
        'HttpAdapter not found. ' + 'Run the application via NestFactory.create() or provide your own adapter.'
      );
    }

    const app = httpAdapter.getInstance();

    if (ssl?.enabled && ssl.key && ssl.cert) {
      try {
        // Create HTTPS server with SSL options
        const httpsOptions = {
          key: readFileSync(ssl.key, 'utf8'),
          cert: readFileSync(ssl.cert, 'utf8'),
          ...(ssl.ca && { ca: readFileSync(ssl.ca, 'utf8') }),
        };

        const httpsServer = createServer(httpsOptions, app);

        httpsServer.listen(port, host, () => {
          this.logger.info(`HTTPS server listening on ${host}:${port}`);
        });

        httpsServer.on('error', (error) => {
          this.logger.error('HTTPS server error:', { args: { error } });
        });
      } catch (sslError) {
        this.logger.error('Failed to start HTTPS server:', { args: { sslError } });
        throw sslError;
      }
    } else {
      // Start regular HTTP server
      app.listen(port, host, () => {
        this.logger.info(`HTTP server listening on ${host}:${port}`);
      });

      app.on('error', (error: any) => {
        this.logger.error('HTTP server error:', { args: { error } });
      });
    }
  }
}

@Module({})
export class HttpTransportModule {
  static forRoot(options: HttpServerOptions): DynamicModule {
    return {
      module: HttpTransportModule,
      imports: [LoggerModule.forRoot({ componentName: 'HttpTransportModule' })],
      controllers: [RpcController, StreamController],
      providers: [
        {
          provide: 'HTTP_OPTIONS',
          useValue: options,
        },
        HttpServerManager,
      ],
      exports: ['HTTP_OPTIONS'],
    };
  }
}
