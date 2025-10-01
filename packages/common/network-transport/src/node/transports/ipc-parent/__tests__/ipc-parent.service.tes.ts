import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule, QueryBus } from '@easylayer/common/cqrs';
import { IpcParentTransportService } from '../ipc-parent.service';
import { Actions } from '../../../../core';
import { EventEmitter } from 'events';

class FakeChild extends EventEmitter {
  send = jest.fn();
  once = super.once.bind(this) as any;
  off = super.off.bind(this) as any;
}

describe('IpcParentTransportService', () => {
  let modRef: TestingModule | undefined;
    
  afterEach(async () => {
    try { await modRef?.close(); } catch {}
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('requires child in options and goes online on pong', async () => {
    const child = new FakeChild();
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcParentTransportService, useFactory: (qb: QueryBus) => new IpcParentTransportService({ type: 'ipc-parent', child, ping: { password: 'pw', minMs: 10, factor: 1.1, maxMs: 20 } } as any, qb), inject: [QueryBus] }],
    }).compile();
    const svc = modRef.get(IpcParentTransportService) as any;
    const p = svc.waitForOnline(500);
    child.emit('message', { action: Actions.Pong, payload: { password: 'pw' } });
    await expect(p).resolves.toBeUndefined();
    expect(svc.isOnline()).toBe(true);
  });

  it('executes QueryRequest and replies to child', async () => {
    const exec = jest.fn(async () => ({ ok: true }));
    const child = new FakeChild();
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcParentTransportService, useFactory: () => new IpcParentTransportService({ type: 'ipc-parent', child } as any, { execute: exec } as any) }],
    }).compile();
    modRef.get(IpcParentTransportService) as any;
    child.emit('message', { action: Actions.QueryRequest, payload: { name: 'Q', data: 1 }, correlationId: 'c1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(exec).toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ action: Actions.QueryResponse, correlationId: 'c1' }));
  });

  it('resolves ACK for batch', async () => {
    const child = new FakeChild();
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcParentTransportService, useFactory: (qb: QueryBus) => new IpcParentTransportService({ type: 'ipc-parent', child } as any, qb), inject: [QueryBus] }],
    }).compile();
    const svc = modRef.get(IpcParentTransportService) as any;
    const p = svc.waitForAck(200);
    child.emit('message', { action: Actions.OutboxStreamAck, payload: { ok: true, okIndices: [0] } });
    await expect(p).resolves.toEqual({ ok: true, okIndices: [0] });
  });

  it('unsubscribes on destroy', async () => {
    const child = new FakeChild();
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [{ provide: IpcParentTransportService, useFactory: (qb: QueryBus) => new IpcParentTransportService({ type: 'ipc-parent', child } as any, qb), inject: [QueryBus] }],
    }).compile();
    const svc = modRef.get(IpcParentTransportService) as any;
    const offSpy = jest.spyOn(child, 'off');
    await svc.onModuleDestroy();
    expect(offSpy).toHaveBeenCalled();
  });
});
