import { Module, DynamicModule } from '@nestjs/common';
import type { ElectronWsClientOptions } from './electron-ws-client.consumer';
import { ElectronWsClientConsumer } from './electron-ws-client.consumer';

@Module({})
export class ElectronWsClientModule {
  static forRoot(opts: ElectronWsClientOptions): DynamicModule {
    return {
      module: ElectronWsClientModule,
      providers: [{ provide: ElectronWsClientConsumer, useValue: new ElectronWsClientConsumer(opts) }],
      exports: [],
    };
  }
}
