import { Test } from '@nestjs/testing';
import { CqrsModule } from '@easylayer/common/cqrs';
import { IpcChildTransportModule } from '../ipc-child.module';
import { IpcChildProducer } from '../ipc-child.producer';
import { IpcChildConsumer } from '../ipc-child.consumer';
import type { IpcServerOptions } from '../ipc-child.consumer';

const originalProcessSend = (process as any).send;

describe('IpcChildTransportModule', () => {
  beforeEach(() => {
    (process as any).send = () => {};
  });

  afterEach(() => {
    (process as any).send = originalProcessSend;
    jest.restoreAllMocks();
    process.removeAllListeners('message');
  });

  it('wires providers and maps options into producer', async () => {
    const options: IpcServerOptions = {
      type: 'ipc',
      maxMessageSize: 512 * 1024,
      connectionTimeout: 7000,
      heartbeatTimeout: 9000,
      token: 'tok',
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        IpcChildTransportModule.forRoot(options),
        CqrsModule.forRoot({isGlobal: true})
    ],
    })
      .compile();

    const producer = moduleRef.get(IpcChildProducer);
    const alias = moduleRef.get('IPC_PRODUCER');
    const opts = moduleRef.get('IPC_OPTIONS');

    expect(producer).toBeInstanceOf(IpcChildProducer);
    expect(alias).toBe(producer);
    expect(opts).toEqual(options);

    const cfg = (producer as any).configuration;
    expect(cfg.name).toBe('ipc');
    expect(cfg.maxMessageBytes).toBe(options.maxMessageSize);
    expect(cfg.ackTimeoutMs).toBe(options.connectionTimeout);
    expect(cfg.heartbeatTimeoutMs).toBe(options.heartbeatTimeout);
    expect(cfg.heartbeatIntervalMs).toBe(Math.max(500, Math.floor((options.heartbeatTimeout as number) / 2)));

    const consumer = moduleRef.get(IpcChildConsumer);
    expect(consumer).toBeInstanceOf(IpcChildConsumer);
  });
});
