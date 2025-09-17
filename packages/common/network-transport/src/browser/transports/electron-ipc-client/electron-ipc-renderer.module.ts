import { Module, DynamicModule } from '@nestjs/common';
import type { ElectronIpcRendererProducerOptions } from './electron-ipc-renderer.producer';
import { ElectronIpcRendererProducer } from './electron-ipc-renderer.producer';

export const ELECTRON_IPC_RENDERER_PRODUCER = 'ELECTRON_IPC_RENDERER_PRODUCER';

@Module({})
export class ElectronIpcRendererClientModule {
  static forRoot(opts: ElectronIpcRendererProducerOptions = {}): DynamicModule {
    return {
      module: ElectronIpcRendererClientModule,
      providers: [{ provide: ELECTRON_IPC_RENDERER_PRODUCER, useValue: new ElectronIpcRendererProducer(opts) }],
      exports: [ELECTRON_IPC_RENDERER_PRODUCER],
    };
  }
}
