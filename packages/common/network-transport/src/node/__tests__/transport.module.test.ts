import { Test, TestingModule } from '@nestjs/testing';
import { NetworkTransportModule } from '../transport.module';
import { CqrsModule } from '@easylayer/common/cqrs';
import { EventEmitter } from 'events';

class FakeChild extends EventEmitter {
  send = jest.fn();
  once = super.once.bind(this) as any;
  off = super.off.bind(this) as any;
}

describe('NetworkTransportModule', () => {
  let modRef: TestingModule | undefined;

  afterEach(async () => {
    try { await modRef?.close(); } catch {}
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('creates without transports and without outbox', async () => {
    modRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({ isGlobal: true }),
        NetworkTransportModule.forRoot({ transports: [] }),
      ],
    }).compile();
    expect(modRef).toBeDefined();
  });

  it('compiles when outbox enabled with no transports', async () => {
    modRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({ isGlobal: true }),
        NetworkTransportModule.forRoot({ transports: [], outbox: { enabled: true, kind: 'http' } }),
      ],
    }).compile();
    expect(modRef).toBeDefined();
  });

  it('wires DI for http transport with outbox=http', async () => {
    modRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({ isGlobal: true }),
        NetworkTransportModule.forRoot({
          transports: [
            {
              type: 'http',
              host: '127.0.0.1',
              port: 31234,
              webhook: { url: 'http://localhost:9999/hook' },
            },
          ],
          outbox: { enabled: true, kind: 'http' },
        }),
      ],
    }).compile();
    expect(modRef).toBeDefined();
  });

  it('still compiles when outbox kind not present among transports', async () => {
    modRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({ isGlobal: true }),
        NetworkTransportModule.forRoot({
          transports: [{ type: 'ipc-parent', child: new FakeChild() as any }],
          outbox: { enabled: true, kind: 'ws' },
        }),
      ],
    }).compile();
    expect(modRef).toBeDefined();
  });

  it('accepts multiple transports without outbox', async () => {
    modRef = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({ isGlobal: true }),
        NetworkTransportModule.forRoot({
          transports: [
            { type: 'ws', host: '127.0.0.1', port: 31337, password: 'pw' },
            { type: 'ipc-child' },
            { type: 'ipc-parent', child: new FakeChild() as any },
            // { type: 'electron-ipc-main' },
          ],
        }),
      ],
    }).compile();
    expect(modRef).toBeDefined();
  });
});
