import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { NetworkTransportModule, TransportModuleOptions } from '../transport.module';
import {
  HTTP_PRODUCER,
  WS_PRODUCER,
  IPC_PRODUCER
} from '../transports';
import { OutboxStreamManager } from '../../core';

jest.mock('../transports', () => {
  // explicit tokens
  const HTTP_PRODUCER = 'HTTP_PRODUCER';
  const WS_PRODUCER   = 'WS_PRODUCER';
  const IPC_PRODUCER  = 'IPC_PRODUCER';

  const HTTP_OPTIONS = 'HTTP_OPTIONS';
  const WS_OPTIONS   = 'WS_OPTIONS';
  const IPC_OPTIONS  = 'IPC_OPTIONS';

  // helper to create a minimal DynamicModule
  const mkModule = (token: string, name: 'http'|'ws'|'ipc', optsToken: string) => {
    class DummyModule {}
    // simple static forRoot that DOES NOT touch other exports
    (DummyModule as any).forRoot = (opts: any) => ({
      module: DummyModule,
      providers: [
        { provide: token, useValue: { configuration: { name } } },
        { provide: optsToken, useValue: opts },
      ],
      exports: [token, optsToken],
    });
    return DummyModule;
  };

  const HttpTransportModule     = mkModule(HTTP_PRODUCER, 'http', HTTP_OPTIONS);
  const WsTransportModule       = mkModule(WS_PRODUCER,   'ws',   WS_OPTIONS);
  const IpcChildTransportModule = mkModule(IPC_PRODUCER,  'ipc',  IPC_OPTIONS);

  // stubs for unused re-exports to keep the barrel happy
  const ElectronWsClientModule   = { forRoot: (_: any) => ({ module: class {}, providers: [], exports: [] }) };
  const ElectronIpcClientModule  = { forRoot: (_: any) => ({ module: class {}, providers: [], exports: [] }) };
  const IpcParentTransportModule = { forRoot: (_: any) => ({ module: class {}, providers: [], exports: [] }) };

  // IMPORTANT: mark as ES module explicitly
  return {
    __esModule: true,
    HTTP_PRODUCER, WS_PRODUCER, IPC_PRODUCER,
    HttpTransportModule, WsTransportModule, IpcChildTransportModule,
    ElectronWsClientModule, ElectronIpcClientModule, IpcParentTransportModule,
  };
});

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
    const http = moduleRef.get(HTTP_PRODUCER);
    const ws = moduleRef.get(WS_PRODUCER);
    const ipc = moduleRef.get(IPC_PRODUCER);

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
