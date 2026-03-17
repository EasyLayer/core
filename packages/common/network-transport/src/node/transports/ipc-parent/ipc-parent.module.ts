import { Module, DynamicModule, Logger } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { IpcParentTransportService } from './ipc-parent.service';
import type { IpcParentOptions } from './ipc-parent.service';

@Module({})
export class IpcParentTransportModule {
  private static readonly logger = new Logger(IpcParentTransportModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: IpcParentOptions): DynamicModule {
    this.logger.verbose('Starting network ipc-parent-transport module registration', {
      module: this.moduleName,
    });

    return {
      module: IpcParentTransportModule,
      providers: [
        {
          provide: IpcParentTransportService,
          useFactory: (queryBus: QueryBus) => new IpcParentTransportService(opts, queryBus),
          inject: [QueryBus],
        },
      ],
      exports: [IpcParentTransportService],
    };
  }
}
