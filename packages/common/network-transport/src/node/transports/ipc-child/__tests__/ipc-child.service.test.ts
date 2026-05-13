import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule, QueryBus } from '@easylayer/common/cqrs';
import { IpcChildTransportService } from '../ipc-child.service';
import { Actions } from '../../../../core';

describe('IpcChildTransportService', () => {
  const listeners: Function[] = [];
  const origOn = process.on.bind(process);
  const origOff = (process as any).off?.bind(process) || ((ev: any, fn: any) => {});
  const origSend = (process as any).send;
  const hadOrigChannel = Object.prototype.hasOwnProperty.call(process as any, 'channel');
  const origChannel = (process as any).channel;
  const hadOrigConnected = Object.prototype.hasOwnProperty.call(process as any, 'connected');
  const origConnected = (process as any).connected;
  let modRef: TestingModule | undefined;

  beforeEach(() => {
    (process as any).on = ((ev: string, fn: any) => {
      if (ev === 'message') listeners.push(fn);
      return process as any;
    }) as any;
    (process as any).off = ((ev: string, fn: any) => {}) as any;
    (process as any).send = jest.fn();
    Object.defineProperty(process, 'channel', { value: {}, configurable: true });
    Object.defineProperty(process, 'connected', { value: true, configurable: true });
    listeners.length = 0;
  });

  afterEach(async () => {
    (process as any).on = origOn as any;
    (process as any).off = origOff as any;
    (process as any).send = origSend;
    if (hadOrigChannel) {
      Object.defineProperty(process, 'channel', { value: origChannel, configurable: true });
    } else {
      delete (process as any).channel;
    }
    if (hadOrigConnected) {
      Object.defineProperty(process, 'connected', { value: origConnected, configurable: true });
    } else {
      delete (process as any).connected;
    }

    try { await modRef?.close(); } catch {}
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('waitForOnline resolves after pong with correct password', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcChildTransportService, useFactory: (qb: QueryBus) => new IpcChildTransportService({ type: 'ipc-child', ping: { password: 'pw', minMs: 10, factor: 1.1, maxMs: 20 } } as any, qb), inject: [QueryBus] }],
    }).compile();
    const svc = modRef.get(IpcChildTransportService) as any;
    const p = svc.waitForOnline(300);
    listeners.forEach((fn) => fn({ action: Actions.Pong, payload: { password: 'pw' } }));
    await expect(p).resolves.toBeUndefined();
    expect(svc.isOnline()).toBe(true);
  });

  it('executes QueryRequest and replies with QueryResponse', async () => {
    const exec = jest.fn(async () => ({ ok: true }));
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcChildTransportService, useFactory: () => new IpcChildTransportService({ type: 'ipc-child' } as any, { execute: exec } as any) }],
    }).compile();
    modRef.get(IpcChildTransportService) as any;
    listeners.forEach((fn) => fn({ action: Actions.QueryRequest, payload: { name: 'Q', data: 1 }, correlationId: 'c1' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(exec).toHaveBeenCalled();
    expect((process as any).send).toHaveBeenCalledWith(expect.objectContaining({ action: Actions.QueryResponse, correlationId: 'c1' }));
  });

  it('resolves ACK for batch', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcChildTransportService, useFactory: (qb: QueryBus) => new IpcChildTransportService({ type: 'ipc-child' } as any, qb), inject: [QueryBus] }],
    }).compile();
    const svc = modRef.get(IpcChildTransportService) as any;
    await svc.send({ action: Actions.OutboxStreamBatch, correlationId: 'ack-1', payload: { events: [] } } as any);
    const p = svc.waitForAck(200, 'ack-1');
    listeners.forEach((fn) => fn({ action: Actions.OutboxStreamAck, correlationId: 'ack-1', payload: { ok: true, okIndices: [0] } }));
    await expect(p).resolves.toEqual({ ok: true, okIndices: [0], correlationId: 'ack-1' });
  });

  it('unsubscribes on destroy', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcChildTransportService, useFactory: (qb: QueryBus) => new IpcChildTransportService({ type: 'ipc-child' } as any, qb), inject: [QueryBus] }],
    }).compile();
    const svc = modRef.get(IpcChildTransportService) as any;
    const offSpy = jest.spyOn(process as any, 'off');
    await svc.onModuleDestroy();
    expect(offSpy).toHaveBeenCalled();
  });
});
