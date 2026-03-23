import { Module, DynamicModule } from '@nestjs/common';
import { OutboxBatchSender } from '../core';
import type { TransportKind, TransportPort } from '../core';
import type {
  HttpServiceOptions,
  IpcChildOptions,
  IpcParentOptions,
  WsServiceOptions,
  ElectronIpcMainOptions,
} from './transports';
import {
  HttpTransportModule,
  HttpTransportService,
  IpcChildTransportModule,
  IpcChildTransportService,
  IpcParentTransportModule,
  IpcParentTransportService,
  WsTransportModule,
  WsTransportService,
  ElectronIpcMainModule,
  ElectronIpcMainService,
} from './transports';

export type ServerTransportConfig =
  | HttpServiceOptions
  | IpcChildOptions
  | IpcParentOptions
  | WsServiceOptions
  | ElectronIpcMainOptions;

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
        imports.push(HttpTransportModule.forRoot(t as HttpServiceOptions));
        map.push({ kind, token: HttpTransportService });
      }
      if (kind === 'ipc-child') {
        imports.push(IpcChildTransportModule.forRoot(t as IpcChildOptions));
        map.push({ kind, token: IpcChildTransportService });
      }
      if (kind === 'ipc-parent') {
        imports.push(IpcParentTransportModule.forRoot(t as IpcParentOptions));
        map.push({ kind, token: IpcParentTransportService });
      }
      if (kind === 'ws') {
        imports.push(WsTransportModule.forRoot(t as WsServiceOptions));
        map.push({ kind, token: WsTransportService });
      }
      if (kind === 'electron-ipc-main') {
        imports.push(ElectronIpcMainModule.forRoot(t as ElectronIpcMainOptions));
        map.push({ kind, token: ElectronIpcMainService });
      }
    }

    const injectTokens = map.map((m) => m.token);

    const providers = [
      {
        provide: OutboxBatchSender,
        useFactory: (...ports: TransportPort[]) => {
          const sender = new OutboxBatchSender();

          // If outbox is enabled, try to bind the matching transport.
          if (outbox?.enabled) {
            const target = outbox.kind;
            const port = ports.find((p) => p && p.kind === target);
            if (!port) {
              // No matching transport provisioned; leave sender without transport.
              // This is intentional: app can still run without outbox bound.
            } else {
              sender.setTransport(port);
            }
          }
          // If outbox is disabled or not provided, sender remains without transport.

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
