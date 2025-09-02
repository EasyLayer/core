import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { NetworkTransportModule, TransportModuleOptions } from '../transport.module';
import { OutboxStreamManager } from '../core';

jest.mock('../transports/http/http.module', () => {
  class HttpTransportModule {
    static forRoot(_opts: any) {
      const httpProducer = { configuration: { name: 'http' } };
      return {
        module: HttpTransportModule,
        providers: [{ provide: 'HTTP_PRODUCER', useValue: httpProducer }, { provide: 'HTTP_OPTIONS', useValue: _opts }],
        exports: ['HTTP_PRODUCER', 'HTTP_OPTIONS'],
      };
    }
  }
  return { HttpTransportModule };
}, { virtual: true });

jest.mock('../transports/ws/ws.module', () => {
  class WsTransportModule {
    static forRoot(_opts: any) {
      const wsProducer = { configuration: { name: 'ws' } };
      return {
        module: WsTransportModule,
        providers: [{ provide: 'WS_PRODUCER', useValue: wsProducer }, { provide: 'WS_OPTIONS', useValue: _opts }],
        exports: ['WS_PRODUCER', 'WS_OPTIONS'],
      };
    }
  }
  return { WsTransportModule };
}, { virtual: true });

jest.mock('../transports/ipc-child/ipc-child.module', () => {
  class IpcChildTransportModule {
    static forRoot(_opts: any) {
      const ipcProducer = { configuration: { name: 'ipc' } };
      return {
        module: IpcChildTransportModule,
        providers: [{ provide: 'IPC_PRODUCER', useValue: ipcProducer }, { provide: 'IPC_OPTIONS', useValue: _opts }],
        exports: ['IPC_PRODUCER', 'IPC_OPTIONS'],
      };
    }
  }
  return { IpcChildTransportModule };
}, { virtual: true });

describe('TransportModule', () => {
  it('wires multiple providers and selects streaming by name', async () => {
    const options: TransportModuleOptions = {
      isGlobal: false,
      transports: [
        { type: 'http', webhook: { url: 'https://example/hook' } } as any,
        { type: 'ws' } as any,
        { type: 'ipc' } as any,
      ],
      streaming: 'ws',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NetworkTransportModule.forRoot(options)],
    }).compile();

    const manager = moduleRef.get(OutboxStreamManager);
    const http = moduleRef.get('HTTP_PRODUCER');
    const ws = moduleRef.get('WS_PRODUCER');
    const ipc = moduleRef.get('IPC_PRODUCER');

    expect(http?.configuration?.name).toBe('http');
    expect(ws?.configuration?.name).toBe('ws');
    expect(ipc?.configuration?.name).toBe('ipc');

    expect(manager.getProducer()).toBe(ws);
  });

  it('when streaming is not set, manager has no producer', async () => {
    const options: TransportModuleOptions = {
      isGlobal: false,
      transports: [
        { type: 'http', webhook: { url: 'https://example/hook' } } as any,
        { type: 'ws' } as any,
      ],
      // streaming: undefined
    };

    const moduleRef = await Test.createTestingModule({
      imports: [NetworkTransportModule.forRoot(options)],
    }).compile();

    const manager = moduleRef.get(OutboxStreamManager);
    expect(manager.getProducer()).toBeNull();
  });

  it('throws if requested streaming transport was not provisioned', async () => {
    const options: TransportModuleOptions = {
      isGlobal: false,
      transports: [
        { type: 'http', webhook: { url: 'https://example/hook' } } as any,
        { type: 'ws' } as any,
      ],
      streaming: 'ipc', // not present
    };

    await expect(
      Test.createTestingModule({
        imports: [NetworkTransportModule.forRoot(options)],
      }).compile()
    ).rejects.toThrow('Streaming transport "ipc" was requested but not provisioned');
  });
});
