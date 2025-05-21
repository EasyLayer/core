import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/common/logger';
import { WsGateway } from './ws.gateway';
import { WsProducer } from './ws.producer';

export interface WsModuleOptions {
  type: 'ws';
  port?: number;
}

@Module({})
export class WsModule {
  static forRootAsync({ port }: WsModuleOptions): DynamicModule {
    return {
      module: WsModule,
      imports: [LoggerModule.forRoot({ componentName: 'WsModule' })],
      providers: [WsGateway, WsProducer],
      exports: [WsProducer],
    };
  }
}
