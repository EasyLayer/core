import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/common/logger';
import { RpcController } from './rpc.controller';
import { StreamController } from './stream.controller';

export interface HttpServerOptions {
  type: 'http';
  isEnabled: boolean;
  port?: number;
  path?: string;
  streamPath?: string;
  name?: string;
  maxMessageSize?: number;
  connectionTimeout?: number;
}

@Module({})
export class HttpTransportModule {
  static forRoot(options: HttpServerOptions): DynamicModule {
    return {
      module: HttpTransportModule,
      imports: [LoggerModule.forRoot({ componentName: 'HttpTransportModule' })],
      controllers: [RpcController, StreamController],
      providers: [
        {
          provide: 'HTTP_OPTIONS',
          useValue: options,
        },
      ],
      exports: [],
    };
  }
}
