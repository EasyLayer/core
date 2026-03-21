import { Module, DynamicModule } from '@nestjs/common';
import { ElectronIpcRendererService } from './electron-ipc-renderer.service';
import type { ElectronIpcRendererOptions } from './electron-ipc-renderer.service';

@Module({})
export class ElectronIpcRendererModule {
  static forRoot(opts: ElectronIpcRendererOptions): DynamicModule {
    return {
      module: ElectronIpcRendererModule,
      providers: [{ provide: ElectronIpcRendererService, useFactory: () => new ElectronIpcRendererService(opts) }],
      exports: [ElectronIpcRendererService],
    };
  }
}
