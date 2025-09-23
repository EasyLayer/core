import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { IpcParentTransportService } from './ipc-parent.service';
import type { IpcParentOptions } from './ipc-parent.service';

@Module({})
export class IpcParentTransportModule {
  static forRoot(opts: IpcParentOptions): DynamicModule {
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
