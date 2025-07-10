import { Module, DynamicModule } from '@nestjs/common';
import { AppLogger, LoggerModule } from '@easylayer/common/logger';
import { ProducersManager, BaseProducer } from './core';
import { OutgoingMessage } from './shared';
import {
  HttpTransportModule,
  HttpServerOptions,
  WsTransportModule,
  WsServerOptions,
  IpcChildTransportModule,
  IpcServerOptions,
} from './transports';

// Union type for all transport configurations
export type ServerTransportConfig = HttpServerOptions | WsServerOptions | IpcServerOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports: ServerTransportConfig[];
}

@Module({})
export class TransportModule {
  static forRoot(options: TransportModuleOptions): DynamicModule {
    const imports: any[] = [LoggerModule.forRoot({ componentName: 'TransportModule' })];
    const producerTokens: string[] = [];

    const { transports } = options;

    for (const transportConfig of transports) {
      if (!transportConfig.isEnabled) continue;

      if (transportConfig.type === 'http') {
        imports.push(HttpTransportModule.forRoot(transportConfig));
      }

      if (transportConfig.type === 'ws') {
        imports.push(WsTransportModule.forRoot(transportConfig));
        producerTokens.push('WS_PRODUCER');
      }

      if (transportConfig.type === 'ipc') {
        imports.push(IpcChildTransportModule.forRoot(transportConfig));
        producerTokens.push('IPC_PRODUCER');
      }
    }

    return {
      module: TransportModule,
      global: options.isGlobal || false,
      imports,
      providers: [
        {
          provide: ProducersManager,
          useFactory: (logger: AppLogger, ...producers: BaseProducer<OutgoingMessage>[]) => {
            const validProducers = producers.filter(Boolean);
            logger.info(`Initializing Transport ProducersManager with ${validProducers.length} producers`);
            return new ProducersManager(logger, validProducers);
          },
          inject: [AppLogger, ...(producerTokens.length > 0 ? producerTokens : [])],
        },
      ],
      exports: [ProducersManager],
    };
  }
}
