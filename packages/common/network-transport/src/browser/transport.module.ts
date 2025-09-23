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

export type ServerTransportConfig = HttpBrowserClientOptions | WsBrowserClientOptions | ElectronIpcRendererOptions;

export interface TransportModuleOptions {
  isGlobal?: boolean;
  transports?: ServerTransportConfig[];
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

    const providers: any[] = [];
    const exportsArr: any[] = [];

    if (outbox?.enabled) {
      const m = map.find((x) => x.kind === outbox.kind);
      if (!m) throw new Error(`Outbox enabled but transport "${outbox.kind}" is not provisioned`);
      providers.push({
        provide: OutboxBatchSender,
        useFactory: (port: TransportPort) => {
          const s = new OutboxBatchSender();
          s.setTransport(port);
          return s;
        },
        inject: [m.token],
      });
      exportsArr.push(OutboxBatchSender);
    }

    return {
      module: NetworkTransportModule,
      global: isGlobal ?? false,
      imports,
      providers,
      exports: exportsArr,
    };
  }
}
