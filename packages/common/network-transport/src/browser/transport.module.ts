import { Module, DynamicModule } from '@nestjs/common';
import { OutboxStreamManager } from '../core';
import type { BaseProducer } from '../core';
import {
  ElectronIpcRendererClientModule,
  ElectronWsRendererClientModule,
  ElectronIpcRendererProducerOptions,
  ElectronWsRendererProducerOptions,
  ELECTRON_IPC_RENDERER_PRODUCER,
  ELECTRON_WS_RENDERER_PRODUCER,
} from './transports';

// Keep the same signature as Node version:
export type ServerTransportConfig = ElectronIpcRendererProducerOptions | ElectronWsRendererProducerOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports: ServerTransportConfig[];
  streaming?: 'ws' | 'ipc';
}

function assertBrowserRuntime() {
  if (typeof window === 'undefined') {
    throw new Error('Browser transport module cannot be used in Node runtime');
  }
}

@Module({})
export class NetworkTransportModule {
  static forRoot(options: TransportModuleOptions): DynamicModule {
    assertBrowserRuntime();

    const imports: any[] = [];
    const providers: any[] = [];
    const producerTokens: string[] = [];

    for (const t of options.transports) {
      const type = (t as any).type;

      if (type === 'ipc') {
        imports.push(ElectronIpcRendererClientModule.forRoot(t as ElectronIpcRendererProducerOptions));
        producerTokens.push(ELECTRON_IPC_RENDERER_PRODUCER);
      }
      if (type === 'ws') {
        imports.push(ElectronWsRendererClientModule.forRoot(t as ElectronWsRendererProducerOptions));
        producerTokens.push(ELECTRON_WS_RENDERER_PRODUCER);
      }
    }

    providers.push({
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
    });

    return {
      module: NetworkTransportModule,
      global: options.isGlobal ?? false,
      imports,
      providers,
      exports: [OutboxStreamManager],
    };
  }
}
