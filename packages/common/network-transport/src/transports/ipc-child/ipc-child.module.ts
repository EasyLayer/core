import { Module, DynamicModule, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { IpcChildConsumer } from './ipc-child.consumer';
import { IpcChildProducer } from './ipc-child.producer';

export interface IpcServerOptions {
  type: 'ipc';
  maxMessageSize?: number; // hard cap for serialized envelopes
  heartbeatTimeout?: number; // e.g. 8000
  connectionTimeout?: number; // used as ackTimeoutMs, e.g. 5000
  token?: string; // optional, if вы захотите auth поверх IPC
}

class IpcServerManager implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject('IPC_OPTIONS')
    private readonly options: IpcServerOptions,
    private readonly logger: AppLogger
  ) {}

  async onModuleInit() {
    // Verify this is running in a child process
    if (!process.send) {
      throw new Error('IPC transport requires running in a child process with IPC channel');
    }
    if (!process.connected) {
      throw new Error('IPC transport requires active connection to parent process');
    }

    this.setupProcessHandlers();

    this.logger.info('IPC transport initialized in child process', {
      args: {
        pid: process.pid,
        ppid: process.ppid,
        connected: process.connected,
      },
    });
  }

  async onModuleDestroy() {
    this.cleanupProcessHandlers();
    this.logger.info('IPC transport destroyed');
  }

  private setupProcessHandlers() {
    process.on('disconnect', () => {
      this.logger.warn('Parent process disconnected, shutting down');
      process.exit(0);
    });
    process.on('error', (error) => this.logger.error('IPC process error:', { args: { error } }));
    process.on('unhandledRejection', (reason, promise) =>
      this.logger.error('Unhandled rejection in IPC process:', { args: { reason, promise: String(promise) } })
    );
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception in IPC process:', { args: { error } });
      process.exit(1);
    });
  }

  private cleanupProcessHandlers() {
    process.removeAllListeners('disconnect');
    process.removeAllListeners('error');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  }
}

// CHILD-PROCESS-ONLY IPC module
@Module({
  imports: [LoggerModule.forRoot({ componentName: 'IpcTransportModule' })],
  providers: [
    { provide: 'IPC_OPTIONS', useValue: {} },

    // Producer factory: map IpcServerOptions -> ProducerConfig
    {
      provide: IpcChildProducer,
      useFactory: (logger: AppLogger, opts: IpcServerOptions) => {
        const heartbeatTimeoutMs = opts.heartbeatTimeout ?? 8000;
        return new IpcChildProducer(logger, {
          name: 'ipc',
          maxMessageBytes: opts.maxMessageSize ?? 1024 * 1024,
          ackTimeoutMs: opts.connectionTimeout ?? 5000,
          heartbeatMs: Math.max(500, Math.floor(heartbeatTimeoutMs / 2)),
          heartbeatTimeoutMs,
          token: opts.token,
        });
      },
      inject: [AppLogger, 'IPC_OPTIONS'],
    },
    { provide: 'IPC_PRODUCER', useExisting: IpcChildProducer },

    // Consumer (listens on process.on('message'))
    IpcChildConsumer,

    // Manager (lifecycle & process handlers)
    IpcServerManager,
  ],
  exports: ['IPC_PRODUCER', 'IPC_OPTIONS'],
})
export class IpcChildTransportModule {
  static forRoot(options: IpcServerOptions): DynamicModule {
    return {
      module: IpcChildTransportModule,
      providers: [{ provide: 'IPC_OPTIONS', useValue: options }],
      exports: ['IPC_PRODUCER', 'IPC_OPTIONS'],
    };
  }
}
