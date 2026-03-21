import { Module, DynamicModule } from '@nestjs/common';
import { OutboxBatchSender } from '../core';
import type { TransportKind, TransportPort } from '../core';
import type { HttpBrowserClientOptions, WsBrowserClientOptions, ElectronIpcRendererOptions } from './transports';
import {
  HttpBrowserClientModule,
  HttpBrowserService,
  WsBrowserClientModule,
  WsBrowserTransportService,
  ElectronIpcRendererModule,
  ElectronIpcRendererService,
} from './transports';

export type BrowserTransportConfig = HttpBrowserClientOptions | WsBrowserClientOptions | ElectronIpcRendererOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports?: BrowserTransportConfig[];
  outbox?: { enabled: boolean; kind: TransportKind };
}

@Module({})
export class NetworkTransportModule {
  static forRoot(options: TransportModuleOptions): DynamicModule {
    const { isGlobal, transports = [], outbox } = options ?? {};

    const imports: DynamicModule[] = [];
    const map: Array<{ kind: TransportKind; token: any }> = [];

    for (const t of transports) {
      const kind = (t as any).type as TransportKind;
      if (kind === 'http') {
        imports.push(HttpBrowserClientModule.forRoot(t as HttpBrowserClientOptions));
        map.push({ kind, token: HttpBrowserService });
      }
      if (kind === 'ws') {
        imports.push(WsBrowserClientModule.forRoot(t as WsBrowserClientOptions));
        map.push({ kind, token: WsBrowserTransportService });
      }
      if (kind === 'electron-ipc-renderer') {
        imports.push(ElectronIpcRendererModule.forRoot(t as ElectronIpcRendererOptions));
        map.push({ kind, token: ElectronIpcRendererService });
      }
    }

    const injectTokens = map.map((m) => m.token);

    // Always register OutboxBatchSender — same pattern as node version.
    // If outbox is disabled or no matching transport — sender stays without transport
    // and simply skips sending (CqrsTransportModule always needs the token).
    const providers: any[] = [
      {
        provide: OutboxBatchSender,
        useFactory: (...ports: TransportPort[]) => {
          const sender = new OutboxBatchSender();

          if (outbox?.enabled) {
            const port = ports.find((p) => p && p.kind === outbox.kind);
            if (port) {
              sender.setTransport(port);
            }
            // No matching transport provisioned — sender runs without transport.
            // This is intentional: app can still run, outbox batches are silently skipped.
          }

          return sender;
        },
        inject: injectTokens,
      },
    ];

    return {
      module: NetworkTransportModule,
      global: isGlobal ?? false,
      imports,
      providers,
      exports: [OutboxBatchSender],
    };
  }
}
