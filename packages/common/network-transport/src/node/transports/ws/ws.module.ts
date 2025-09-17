import { Module, DynamicModule, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createServer, Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { QueryBus } from '@easylayer/common/cqrs';
import { WsProducer, WsProducerConfig } from './ws.producer';
import { WsGateway } from './ws.gateway';

export const WS_PRODUCER = 'WS_PRODUCER';

export interface WsServerOptions {
  type: 'ws';
  port?: number;
  host?: string;
  path?: string;
  maxMessageSize?: number;
  cors?: {
    origin: string | string[];
    credentials?: boolean;
  };
  heartbeatTimeout?: number;
  connectionTimeout?: number;
  token?: string;
  ssl?: {
    enabled: boolean;
    key?: string;
    cert?: string;
    ca?: string;
  };
  transports?: ('websocket' | 'polling')[];
}

class WsServerManager implements OnModuleInit, OnModuleDestroy {
  private httpServer: HttpServer | HttpsServer | null = null;
  private ioServer: SocketIOServer | null = null;

  constructor(
    @Inject('WS_OPTIONS') private readonly options: WsServerOptions,
    private readonly producer: WsProducer,
    private readonly gateway: WsGateway
  ) {}

  async onModuleInit() {
    const {
      port = 3001,
      host = '0.0.0.0',
      path = '/',
      ssl,
      cors,
      transports = ['websocket', 'polling'],
    } = this.options;

    if (ssl?.enabled && ssl.key && ssl.cert) {
      const httpsOptions = {
        key: readFileSync(ssl.key, 'utf8'),
        cert: readFileSync(ssl.cert, 'utf8'),
        ...(ssl.ca && { ca: readFileSync(ssl.ca, 'utf8') }),
      };
      this.httpServer = createServer(httpsOptions);
    } else {
      this.httpServer = createHttpServer();
    }

    this.ioServer = new SocketIOServer(this.httpServer, {
      path,
      cors: cors || { origin: '*', credentials: false },
      transports,
      pingTimeout: this.options.heartbeatTimeout || 10000,
      pingInterval: Math.max(500, Math.floor((this.options.heartbeatTimeout || 10000) / 2)),
      maxHttpBufferSize: this.options.maxMessageSize || 1024 * 1024,
    });

    this.producer.setServer(this.ioServer);
    this.gateway.setServer(this.ioServer);

    this.ioServer.on('connection', (socket: Socket) => {
      socket.on('disconnect', () => {});
      socket.on('message', (data) => this.gateway.handleMessage(data, socket).catch(() => {}));
    });

    this.httpServer.listen(port, host);
    this.httpServer.on('error', () => {});
  }

  async onModuleDestroy() {
    if (this.ioServer) {
      this.ioServer.close();
      this.ioServer = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

@Module({
  providers: [
    { provide: 'WS_OPTIONS', useValue: {} },
    {
      provide: WsProducer,
      useFactory: (opts: WsServerOptions) => {
        const cfg: WsProducerConfig = {
          name: 'ws',
          maxMessageBytes: opts.maxMessageSize ?? 1024 * 1024,
          ackTimeoutMs: opts.connectionTimeout ?? 5000,
          heartbeatIntervalMs: Math.max(500, Math.floor((opts.heartbeatTimeout ?? 10000) / 2)),
          heartbeatTimeoutMs: opts.heartbeatTimeout ?? 10000,
          token: opts.token,
        };
        const producer = new WsProducer(cfg);
        producer.startHeartbeat();
        return producer;
      },
      inject: ['WS_OPTIONS'],
    },
    { provide: WS_PRODUCER, useExisting: WsProducer },
    {
      provide: WsGateway,
      useFactory: (queryBus: QueryBus, producer: WsProducer, opts: WsServerOptions) =>
        new WsGateway(queryBus, producer, opts.token),
      inject: [QueryBus, WsProducer, 'WS_OPTIONS'],
    },
    WsServerManager,
  ],
  exports: [WS_PRODUCER],
})
export class WsTransportModule {
  static forRoot(options: WsServerOptions): DynamicModule {
    return {
      module: WsTransportModule,
      providers: [{ provide: 'WS_OPTIONS', useValue: options }],
      exports: [WS_PRODUCER],
    };
  }
}
