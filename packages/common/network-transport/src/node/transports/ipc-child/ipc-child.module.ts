import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { IpcChildProducer } from './ipc-child.producer';
import { IpcChildConsumer } from './ipc-child.consumer';
import type { IpcServerOptions } from './ipc-child.consumer';

export const IPC_PRODUCER = 'IPC_PRODUCER';
@Module({
  providers: [
    { provide: 'IPC_OPTIONS', useValue: {} },
    {
      provide: IpcChildProducer,
      useFactory: (opts: IpcServerOptions) =>
        new IpcChildProducer({
          name: 'ipc',
          maxMessageBytes: opts.maxMessageSize ?? 1024 * 1024,
          ackTimeoutMs: opts.connectionTimeout ?? 5000,
          heartbeatIntervalMs: Math.max(500, Math.floor((opts.heartbeatTimeout ?? 8000) / 2)),
          heartbeatTimeoutMs: opts.heartbeatTimeout ?? 8000,
        }),
      inject: ['IPC_OPTIONS'],
    },
    { provide: IPC_PRODUCER, useExisting: IpcChildProducer },
    {
      provide: IpcChildConsumer,
      useFactory: (queryBus: QueryBus, producer: IpcChildProducer, opts: IpcServerOptions) =>
        new IpcChildConsumer(queryBus, producer, opts),
      inject: [QueryBus, IpcChildProducer, 'IPC_OPTIONS'],
    },
  ],
  exports: [IPC_PRODUCER],
})
export class IpcChildTransportModule {
  static forRoot(options: IpcServerOptions): DynamicModule {
    return {
      module: IpcChildTransportModule,
      providers: [{ provide: 'IPC_OPTIONS', useValue: options }],
      exports: [IPC_PRODUCER],
    };
  }
}
