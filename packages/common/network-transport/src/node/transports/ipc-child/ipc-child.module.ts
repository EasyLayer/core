import { Module, DynamicModule, Logger } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { IpcChildTransportService } from './ipc-child.service';
import type { IpcChildOptions } from './ipc-child.service';

@Module({})
export class IpcChildTransportModule {
  private static readonly logger = new Logger(IpcChildTransportModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: IpcChildOptions): DynamicModule {
    this.logger.verbose('Starting network ipc-child-transport module registration', {
      module: this.moduleName,
    });

    return {
      module: IpcChildTransportModule,
      providers: [
        {
          provide: IpcChildTransportService,
          useFactory: (queryBus: QueryBus) => new IpcChildTransportService(opts, queryBus),
          inject: [QueryBus],
        },
      ],
      exports: [IpcChildTransportService],
    };
  }
}
