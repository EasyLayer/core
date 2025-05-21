import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/common/logger';
import { IpcChildConsumer } from './ipc-child.consumer';
import { IpcChildProducer } from './ipc-child.producer';

// This IPC Service is for only CHILD PROCCESS

export interface IPChildModuleOptions {
  type: 'ipc';
  isEnable: boolean;
}

@Module({})
export class IPChildModule {
  static forRootAsync(otpions: IPChildModuleOptions): DynamicModule {
    return {
      module: IPChildModule,
      imports: [LoggerModule.forRoot({ componentName: 'IPChildModule' })],
      providers: [IpcChildConsumer, IpcChildProducer],
      exports: [IpcChildProducer],
    };
  }
}
