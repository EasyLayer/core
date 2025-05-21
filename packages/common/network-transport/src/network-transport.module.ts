import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { WsModule, WsProducer, WsModuleOptions } from './ws';
import { TcpModule, TcpProducer, TcpModuleOptions } from './tcp';
import { IPChildModule, IpcChildProducer, IPChildModuleOptions } from './ipc-child';
import { ProducersManager } from './producers-manager';
import { BaseProducer } from './base-producer';

export type TransportOptions = WsModuleOptions | TcpModuleOptions | IPChildModuleOptions;

export interface NetworkTransportModuleOptions {
  isGlobal?: boolean;
  transports: TransportOptions[];
}

@Module({})
export class NetworkTransportModule {
  static forRoot(options: NetworkTransportModuleOptions): DynamicModule {
    const imports = [LoggerModule.forRoot({ componentName: NetworkTransportModule.name })];

    const producerInjectionTokens: any[] = [];

    const { transports } = options;

    transports.forEach((transportOption) => {
      if (transportOption.type === 'ws') {
        imports.push(WsModule.forRootAsync(transportOption));
        producerInjectionTokens.push(WsProducer);
      }

      if (transportOption.type === 'tcp') {
        imports.push(TcpModule.forRootAsync(transportOption));
        producerInjectionTokens.push(TcpProducer);
      }

      if (transportOption.type === 'ipc') {
        imports.push(IPChildModule.forRootAsync(transportOption));
        producerInjectionTokens.push(IpcChildProducer);
      }
    });

    return {
      module: NetworkTransportModule,
      global: options.isGlobal || false,
      imports,
      providers: [
        {
          provide: ProducersManager,
          useFactory: (logger, ...prods: BaseProducer[]) => new ProducersManager(logger, prods),
          inject: [AppLogger, ...producerInjectionTokens],
        },
      ],
      exports: [ProducersManager],
    };
  }
}
