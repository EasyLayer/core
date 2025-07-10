import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/common/logger';
import { WsGateway } from './ws.gateway';
import { WsProducer } from './ws.producer';

export interface WsServerOptions {
  type: 'ws';
  isEnabled: boolean;
  port?: number;
  path?: string;
  name?: string;
  maxMessageSize?: number;
  cors?: {
    origin: string | string[];
    credentials?: boolean;
  };
  heartbeatTimeout?: number;
  connectionTimeout?: number;
}

@Module({})
export class WsTransportModule {
  static forRoot(options: WsServerOptions): DynamicModule {
    return {
      module: WsTransportModule,
      imports: [LoggerModule.forRoot({ componentName: 'WsTransportModule' })],
      providers: [
        {
          provide: 'WS_OPTIONS',
          useValue: options,
        },
        WsGateway,
        WsProducer,
        {
          provide: 'WS_PRODUCER',
          useExisting: WsProducer,
        },
      ],
      exports: ['WS_PRODUCER', 'WS_OPTIONS'],
    };
  }
}
