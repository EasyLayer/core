import { Module, DynamicModule } from '@nestjs/common';
import { OutboxStreamManager } from '../core';
import type { BaseProducer } from '../core';
import {
  HttpTransportModule,
  HttpServerOptions,
  WsTransportModule,
  WsServerOptions,
  IpcChildTransportModule,
  IpcServerOptions,
  ElectronWsClientModule,
  ElectronWsClientOptions,
  ElectronIpcClientModule,
  IpcParentTransportModule,
  ElectronIpcClientOptions,
  IpcParentOptions,
  HTTP_PRODUCER,
  WS_PRODUCER,
  IPC_PRODUCER,
} from './transports';

export type ServerTransportConfig =
  | HttpServerOptions
  | WsServerOptions
  | IpcServerOptions
  | ElectronWsClientOptions
  | ElectronIpcClientOptions
  | IpcParentOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports: ServerTransportConfig[];
  streaming?: 'http' | 'ws' | 'ipc';
}

function assertNodeRuntime() {
  if (typeof window !== 'undefined') {
    throw new Error('Node transport module cannot be used in Browser runtime');
  }
}

@Module({})
export class NetworkTransportModule {
  static forRoot(options: TransportModuleOptions): DynamicModule {
    assertNodeRuntime();

    const imports: any[] = [];
    const producerTokens: string[] = [];

    for (const t of options.transports) {
      const type = (t as any).type;

      if (type === 'http') {
        imports.push(HttpTransportModule.forRoot(t as HttpServerOptions));
        producerTokens.push(HTTP_PRODUCER);
      }
      if (type === 'ws') {
        imports.push(WsTransportModule.forRoot(t as WsServerOptions));
        producerTokens.push(WS_PRODUCER);
      }
      if (type === 'ipc') {
        imports.push(IpcChildTransportModule.forRoot(t as IpcServerOptions));
        producerTokens.push(IPC_PRODUCER);
      }

      // node-side clients and ipc parent (do not add to producerTokens) ---
      if (type === 'electron-ws-client') {
        imports.push(ElectronWsClientModule.forRoot(t as ElectronWsClientOptions));
      }
      if (type === 'electron-ipc-client') {
        imports.push(ElectronIpcClientModule.forRoot(t as ElectronIpcClientOptions));
      }
      if (type === 'ipc-parent') {
        imports.push(IpcParentTransportModule.forRoot(t as IpcParentOptions));
      }
    }

    return {
      module: NetworkTransportModule,
      global: options.isGlobal ?? false,
      imports,
      providers: [
        {
          provide: OutboxStreamManager,
          useFactory: (...producers: BaseProducer[]) => {
            const manager = new OutboxStreamManager();

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
          inject: [...(producerTokens.length > 0 ? producerTokens : [])],
        },
      ],
      exports: [OutboxStreamManager],
    };
  }
}
