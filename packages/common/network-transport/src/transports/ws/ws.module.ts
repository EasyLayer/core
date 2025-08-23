import { Module, DynamicModule, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createServer, Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { WsGateway } from './ws.gateway';
import { WsProducer } from './ws.producer';

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
  heartbeatTimeout?: number; // e.g. 10000 (ms)
  connectionTimeout?: number; // used as ackTimeout for producer, e.g. 5000
  token?: string; // optional auth token for registerStreamConsumer
  ssl?: {
    enabled: boolean;
    key?: string;
    cert?: string;
    ca?: string;
  };
  transports?: ('websocket' | 'polling')[];
}

class WsServerManager implements OnModuleInit, OnModuleDestroy {
  private httpServer: any;
  private ioServer: SocketIOServer | null = null;

  constructor(
    @Inject('WS_OPTIONS') private readonly options: WsServerOptions,
    private readonly producer: WsProducer,
    private readonly gateway: WsGateway,
    private readonly logger: AppLogger
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

    // 1) Create HTTP or HTTPS server
    if (ssl?.enabled && ssl.key && ssl.cert) {
      const httpsOptions = {
        key: readFileSync(ssl.key, 'utf8'),
        cert: readFileSync(ssl.cert, 'utf8'),
        ...(ssl.ca && { ca: readFileSync(ssl.ca, 'utf8') }),
      };
      this.httpServer = createServer(httpsOptions);
      this.logger.info(`Creating WSS server on ${host}:${port}${path}`);
    } else {
      this.httpServer = createHttpServer();
      this.logger.info(`Creating WS server on ${host}:${port}${path}`);
    }

    // 2) Single Socket.IO server instance
    this.ioServer = new SocketIOServer(this.httpServer, {
      path,
      cors: cors || { origin: '*', credentials: false },
      transports,
      // ping timers are Socket.IO internal; we still keep our own heartbeat in producer
      pingTimeout: this.options.heartbeatTimeout || 10000,
      pingInterval: Math.max(500, Math.floor((this.options.heartbeatTimeout || 10000) / 2)),
      maxHttpBufferSize: this.options.maxMessageSize || 1024 * 1024,
    });

    // Pass references to producer and gateway
    this.producer.setServer(this.ioServer);
    this.gateway.setServer(this.ioServer);

    this.setupSocketIOHandlers();

    // 3) Start listening
    this.httpServer.listen(port, host, () => {
      const protocol = ssl?.enabled ? 'wss' : 'ws';
      this.logger.info(`WebSocket server listening on ${protocol}://${host}:${port}${path}`);
    });

    this.httpServer.on('error', (error: any) => {
      this.logger.error('WebSocket server error:', { args: { error } });
    });
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
    this.logger.info('WebSocket server stopped');
  }

  private setupSocketIOHandlers() {
    if (!this.ioServer) return;

    this.ioServer.on('connection', (socket: Socket) => {
      this.logger.debug('Client connected', { args: { socketId: socket.id } });

      socket.on('disconnect', (reason) => {
        this.logger.debug('Client disconnected', { args: { socketId: socket.id, reason } });
      });

      // Forward every business packet to the gateway.
      socket.on('message', (data) => {
        this.logger.debug('Received WS message', { args: { socketId: socket.id, hasData: !!data } });
        this.gateway.handleMessage(data, socket).catch((err) => this.logger.error('Gateway error', { args: { err } }));
      });
    });
  }
}

@Module({
  imports: [LoggerModule.forRoot({ componentName: 'WsTransportModule' })],
  providers: [
    // options
    { provide: 'WS_OPTIONS', useValue: {} },

    // gateway + producer
    WsGateway,
    {
      provide: WsProducer,
      useFactory: (logger: AppLogger, opts: WsServerOptions) => {
        // Map WS options into ProducerConfig
        const heartbeatTimeoutMs = opts.heartbeatTimeout ?? 10000;
        return new WsProducer(logger, {
          name: 'ws',
          maxMessageBytes: opts.maxMessageSize ?? 1024 * 1024,
          ackTimeoutMs: opts.connectionTimeout ?? 5000,
          heartbeatMs: Math.max(500, Math.floor(heartbeatTimeoutMs / 2)),
          heartbeatTimeoutMs,
          token: opts.token,
        });
      },
      inject: [AppLogger, 'WS_OPTIONS'],
    },
    { provide: 'WS_PRODUCER', useExisting: WsProducer },

    // server manager
    WsServerManager,
  ],
  exports: ['WS_PRODUCER', 'WS_OPTIONS'],
})
export class WsTransportModule {
  static forRoot(options: WsServerOptions): DynamicModule {
    return {
      module: WsTransportModule,
      providers: [{ provide: 'WS_OPTIONS', useValue: options }],
      exports: ['WS_PRODUCER', 'WS_OPTIONS'],
    };
  }
}
