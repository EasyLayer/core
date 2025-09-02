import { Module, DynamicModule } from '@nestjs/common';
import { AppLogger, LoggerModule } from '@easylayer/common/logger';
import { OutboxStreamManager } from './core';
import type { BaseProducer } from './core';
import { HttpTransportModule, HttpServerOptions } from './transports/http';
import { WsTransportModule, WsServerOptions } from './transports/ws';
import { IpcChildTransportModule } from './transports/ipc-child';
import type { IpcServerOptions } from './transports/ipc-child';

export type ServerTransportConfig = HttpServerOptions | WsServerOptions | IpcServerOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports: ServerTransportConfig[];
  streaming?: 'http' | 'ws' | 'ipc';
}

@Module({})
export class NetworkTransportModule {
  static forFeature(): DynamicModule {
    return {
      module: NetworkTransportModule,
      providers: [],
      exports: [OutboxStreamManager],
    };
  }

  static forRoot(options: TransportModuleOptions): DynamicModule {
    const imports: any[] = [LoggerModule.forRoot({ componentName: 'NetworkTransportModule' })];
    const producerTokens: string[] = [];

    for (const t of options.transports) {
      if (t.type === 'http') {
        imports.push(HttpTransportModule.forRoot(t as HttpServerOptions));
        producerTokens.push('HTTP_PRODUCER');
      }
      if (t.type === 'ws') {
        imports.push(WsTransportModule.forRoot(t as WsServerOptions));
        producerTokens.push('WS_PRODUCER');
      }
      if (t.type === 'ipc') {
        imports.push(IpcChildTransportModule.forRoot(t as IpcServerOptions));
        producerTokens.push('IPC_PRODUCER');
      }
    }

    return {
      module: NetworkTransportModule,
      global: options.isGlobal ?? false,
      imports,
      providers: [
        {
          provide: OutboxStreamManager,
          useFactory: (logger: AppLogger, ...producers: BaseProducer[]) => {
            const manager = new OutboxStreamManager(logger);

            if (options.streaming) {
              const target = options.streaming;
              let chosen: BaseProducer | null = null;

              for (const p of producers) {
                if (!p) continue;
                const name = (p as any)?.configuration?.name;
                if (name === target) {
                  chosen = p;
                  break;
                }
              }

              if (!chosen) {
                throw new Error(`Streaming transport "${target}" was requested but not provisioned`);
              }

              manager.setProducer(chosen);
            } else {
              manager.setProducer(null);
            }

            return manager;
          },
          inject: [AppLogger, ...(producerTokens.length > 0 ? producerTokens : [])],
        },
      ],
      exports: [OutboxStreamManager],
    };
  }
}
