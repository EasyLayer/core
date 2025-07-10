import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/common/logger';
import { IpcChildConsumer } from './ipc-child.consumer';
import { IpcChildProducer } from './ipc-child.producer';

export interface IpcServerOptions {
  type: 'ipc';
  isEnabled: boolean;
  name?: string;
  maxMessageSize?: number;
  heartbeatTimeout?: number;
  connectionTimeout?: number;
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
      ],
      exports: ['IPC_PRODUCER'],
    };
  }
}
