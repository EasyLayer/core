import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { IpcChildTransportService } from './ipc-child.service';
import type { IpcChildOptions } from './ipc-child.service';

@Module({})
export class IpcChildTransportModule {
  static forRoot(opts: IpcChildOptions): DynamicModule {
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
