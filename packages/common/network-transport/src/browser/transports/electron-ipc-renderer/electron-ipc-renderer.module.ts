import { Module, DynamicModule, Logger } from '@nestjs/common';
import { ElectronIpcRendererService } from './electron-ipc-renderer.service';
import type { ElectronIpcRendererOptions } from './electron-ipc-renderer.service';

@Module({})
export class ElectronIpcRendererModule {
  private static readonly logger = new Logger(ElectronIpcRendererModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: ElectronIpcRendererOptions): DynamicModule {
    this.logger.verbose('Starting network electron-ipc-renderer-transport module registration', {
      module: this.moduleName,
    });

    return {
      module: ElectronIpcRendererModule,
      providers: [{ provide: ElectronIpcRendererService, useFactory: () => new ElectronIpcRendererService(opts) }],
      exports: [ElectronIpcRendererService],
    };
  }
}
