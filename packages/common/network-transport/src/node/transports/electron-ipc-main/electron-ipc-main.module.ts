import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { ElectronIpcMainService } from './electron-ipc-main.service';
import type { ElectronIpcMainOptions } from './electron-ipc-main.service';

@Module({})
export class ElectronIpcMainModule {
  static forRoot(opts: ElectronIpcMainOptions): DynamicModule {
    return {
      module: ElectronIpcMainModule,
      providers: [
        {
          provide: ElectronIpcMainService,
          useFactory: (queryBus: QueryBus) => new ElectronIpcMainService(opts, queryBus),
          inject: [QueryBus],
        },
      ],
      exports: [ElectronIpcMainService],
    };
  }
}
