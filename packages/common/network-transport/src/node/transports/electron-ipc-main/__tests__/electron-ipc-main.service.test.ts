import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule, QueryBus } from '@easylayer/common/cqrs';
import { ElectronIpcMainService } from '../electron-ipc-main.service';
import { Actions } from '../../../../core';

jest.mock('electron', () => {
  const { EventEmitter } = require('events');
  const ipcMain = new EventEmitter();
  if (!('off' in ipcMain)) {
    // @ts-ignore
    ipcMain.off = (ev: any, fn: any) => ipcMain.removeListener(ev, fn);
  }
  const fakeWC = { send: jest.fn(), id: 1 };
  const webContents = { getAllWebContents: () => [fakeWC] };
  return { ipcMain, webContents };
});

describe('ElectronIpcMainService', () => {
  let modRef: TestingModule | undefined;
  
  afterEach(async () => {
    try { await modRef?.close(); } catch {}
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('goes online on pong and resolves ACK', async () => {
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: ElectronIpcMainService,
          useFactory: (qb: QueryBus) =>
            new ElectronIpcMainService(
              { type: 'electron-ipc-main', ping: { password: 'pw', minMs: 10, factor: 1.1, maxMs: 20 } } as any,
              qb
            ),
          inject: [QueryBus],
        },
      ],
    }).compile();

    const svc = modRef.get(ElectronIpcMainService) as any;
    const { ipcMain } = require('electron');

    const p = svc.waitForOnline(500);
    ipcMain.emit('transport:message', {}, { action: Actions.Pong, payload: { password: 'pw' } });
    await expect(p).resolves.toBeUndefined();

    const ackP = svc.waitForAck(200);
    ipcMain.emit('transport:message', {}, { action: Actions.OutboxStreamAck, payload: { ok: true, okIndices: [0] } });
    await expect(ackP).resolves.toEqual({ ok: true, okIndices: [0] });
  });

  it('executes query and replies via webContents', async () => {
    const exec = jest.fn(async () => ({ ok: true }));
    modRef = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true })],
      providers: [
        {
          provide: ElectronIpcMainService,
          useFactory: () => new ElectronIpcMainService({ type: 'electron-ipc-main' } as any, { execute: exec } as any),
        },
      ],
    }).compile();

    modRef.get(ElectronIpcMainService) as any;
    const { ipcMain, webContents } = require('electron');
    const wc = webContents.getAllWebContents()[0];
    (wc?.send as jest.Mock).mockClear();

    ipcMain.emit('transport:message', {}, { action: Actions.QueryRequest, payload: { name: 'Q', data: 1 }, correlationId: 'r1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(exec).toHaveBeenCalled();
    expect(wc?.send).toHaveBeenCalledWith('transport:message', expect.objectContaining({ action: Actions.QueryResponse }));
  });
});
