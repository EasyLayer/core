import { Module, DynamicModule, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { IpcChildConsumer } from './ipc-child.consumer';
import { IpcChildProducer } from './ipc-child.producer';

export interface IpcServerOptions {
  type: 'ipc';
  maxMessageSize?: number;
  heartbeatTimeout?: number;
  connectionTimeout?: number;
}

class IpcServerManager implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject('IPC_OPTIONS')
    private readonly options: IpcServerOptions,
    private readonly consumer: IpcChildConsumer,
    private readonly producer: IpcChildProducer,
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

    // Set up process event handlers
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
    // Clean up process event handlers
    this.cleanupProcessHandlers();

    this.logger.info('IPC transport destroyed');
  }

  private setupProcessHandlers() {
    // Handle parent process disconnect
    process.on('disconnect', () => {
      this.logger.warn('Parent process disconnected, shutting down');
      process.exit(0);
    });

    // Handle process errors
    process.on('error', (error) => {
      this.logger.error('IPC process error:', { args: { error } });
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection in IPC process:', {
        args: { reason, promise: promise.toString() },
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception in IPC process:', { args: { error } });
      process.exit(1);
    });
  }

  private cleanupProcessHandlers() {
    // Remove event listeners to prevent memory leaks
    process.removeAllListeners('disconnect');
    process.removeAllListeners('error');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
  }
}

// This IPC Service is for CHILD PROCESS only
@Module({})
export class IpcChildTransportModule {
  static forRoot(options: IpcServerOptions): DynamicModule {
    return {
      module: IpcChildTransportModule,
      imports: [LoggerModule.forRoot({ componentName: 'IpcTransportModule' })],
      providers: [
        {
          provide: 'IPC_OPTIONS',
          useValue: options,
        },
        IpcChildConsumer,
        IpcChildProducer,
        {
          provide: 'IPC_PRODUCER',
          useExisting: IpcChildProducer,
        },
        IpcServerManager,
      ],
      exports: ['IPC_PRODUCER', 'IPC_OPTIONS'],
    };
  }
}
