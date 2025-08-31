import { Module, DynamicModule } from '@nestjs/common';
import { AppLogger, LoggerModule } from '@easylayer/common/logger';
import { ProducersManager, BaseProducer } from './core';

import {
  HttpTransportModule,
  HttpServerOptions,
  WsTransportModule,
  WsServerOptions,
  IpcChildTransportModule,
  IpcServerOptions,
  WsProducer,
  IpcChildProducer,
  HttpWebhookProducer,
} from './transports';

export type ServerTransportConfig = HttpServerOptions | WsServerOptions | IpcServerOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports: ServerTransportConfig[];
}

@Module({})
export class TransportModule {
  static forFeature(): DynamicModule {
    return {
      module: TransportModule,
      providers: [],
      exports: [ProducersManager],
    };
  }

  static forRoot(options: TransportModuleOptions): DynamicModule {
    const imports: any[] = [LoggerModule.forRoot({ componentName: 'TransportModule' })];
    const producerTokens: string[] = [];

    for (const transportConfig of options.transports) {
      if (transportConfig.type === 'http') {
        imports.push(HttpTransportModule.forRoot(transportConfig as HttpServerOptions));
        producerTokens.push('HTTP_PRODUCER');
      }
      if (transportConfig.type === 'ws') {
        imports.push(WsTransportModule.forRoot(transportConfig as WsServerOptions));
        producerTokens.push('WS_PRODUCER');
      }
      if (transportConfig.type === 'ipc') {
        imports.push(IpcChildTransportModule.forRoot(transportConfig as IpcServerOptions));
        producerTokens.push('IPC_PRODUCER');
      }
    }

    return {
      module: TransportModule,
      global: options.isGlobal ?? false,
      imports,
      providers: [
        {
          provide: ProducersManager,
          useFactory: (logger: AppLogger, ...producers: BaseProducer[]) => {
            // Build a Map<string, BaseProducer> keyed by transport kind.
            // Prefer cfg.name ('ws'|'http'|'ipc'); fallback to instanceof; final fallback = constructor.name.
            const map = new Map<string, BaseProducer>();

            for (const p of producers) {
              if (!p) continue;

              // Try to read declared name from config (not public in BaseProducer; may require 'as any')
              const cfgName = (p as any)?.cfg?.name || (p as any)?.name;

              let key: string | undefined = typeof cfgName === 'string' ? cfgName : undefined;

              if (!key) {
                if (p instanceof WsProducer) key = 'ws';
                else if (p instanceof HttpWebhookProducer) key = 'http';
                else if (p instanceof IpcChildProducer) key = 'ipc';
                else key = p.constructor?.name || 'unknown';
              }

              // last writer wins — but в конфиге transports у тебя уникальные типы
              map.set(key, p);
            }

            logger.info(`Initializing ProducersManager with [${[...map.keys()].join(', ')}]`);

            // ProducersManager ожидает Map
            return new ProducersManager(logger, map);
          },
          inject: [AppLogger, ...(producerTokens.length > 0 ? producerTokens : [])],
        },
      ],
      exports: [ProducersManager],
    };
  }
}
