import { Module, DynamicModule } from '@nestjs/common';
import type { ElectronIpcClientOptions } from './electron-ipc-client.consumer';
import { ElectronIpcClientConsumer } from './electron-ipc-client.consumer';

@Module({})
export class ElectronIpcClientModule {
  static forRoot(opts: ElectronIpcClientOptions): DynamicModule {
    return {
      module: ElectronIpcClientModule,
      providers: [{ provide: ElectronIpcClientConsumer, useValue: new ElectronIpcClientConsumer(opts) }],
      exports: [],
    };
  }
}
