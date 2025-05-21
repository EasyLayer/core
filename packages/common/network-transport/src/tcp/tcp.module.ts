import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { TcpController } from './tcp.controller';
import { TcpProducer } from './tcp.producer';

export interface TcpModuleOptions {
  type: 'tcp';
  host: string;
  port: number;
}

@Module({})
export class TcpModule {
  static forRootAsync({ port, host }: TcpModuleOptions): DynamicModule {
    return {
      module: TcpModule,
      controllers: [TcpController],
      imports: [LoggerModule.forRoot({ componentName: 'TcpModule' })],
      providers: [
        {
          provide: TcpProducer,
          useFactory: async (logger: AppLogger) => {
            return new TcpProducer(logger, { host, port });
          },
          inject: [AppLogger],
        },
      ],
      exports: [TcpProducer],
    };
  }
}
