import { Module, DynamicModule } from '@nestjs/common';
import type { IpcParentOptions } from './ipc-parent.gateway';
import { IpcParentGateway } from './ipc-parent.gateway';

@Module({})
export class IpcParentTransportModule {
  static forRoot(options: IpcParentOptions): DynamicModule {
    return {
      module: IpcParentTransportModule,
      providers: [{ provide: 'IPC_PARENT_OPTIONS', useValue: options }, IpcParentGateway],
      exports: [],
    };
  }
}
