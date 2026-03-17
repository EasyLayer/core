import { Module, DynamicModule, Logger } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { ElectronIpcMainService } from './electron-ipc-main.service';
import type { ElectronIpcMainOptions } from './electron-ipc-main.service';

@Module({})
export class ElectronIpcMainModule {
  private static readonly logger = new Logger(ElectronIpcMainModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: ElectronIpcMainOptions): DynamicModule {
    this.logger.verbose('Starting network electron-ipc-transport module registration', {
      module: this.moduleName,
    });

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
