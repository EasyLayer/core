import { Module, DynamicModule } from '@nestjs/common';
import type { ElectronWsRendererProducerOptions } from './electron-ws-renderer.producer';
import { ElectronWsRendererProducer } from './electron-ws-renderer.producer';

export const ELECTRON_WS_RENDERER_PRODUCER = 'ELECTRON_WS_RENDERER_PRODUCER';

@Module({})
export class ElectronWsRendererClientModule {
  static forRoot(opts: ElectronWsRendererProducerOptions): DynamicModule {
    return {
      module: ElectronWsRendererClientModule,
      providers: [{ provide: ELECTRON_WS_RENDERER_PRODUCER, useValue: new ElectronWsRendererProducer(opts) }],
      exports: [ELECTRON_WS_RENDERER_PRODUCER],
    };
  }
}
