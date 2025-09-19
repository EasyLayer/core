import { Actions } from '../../../../core';
import type { Envelope, QueryRequestPayload, QueryResponsePayload, PongPayload } from '../../../../core';
import { IpcChildConsumer } from '../ipc-child.consumer';
import { IpcChildProducer } from '../ipc-child.producer';

const originalProcessSend = (process as any).send;

class StubProducer extends IpcChildProducer {
  public sent: Envelope[] = [];
  public verifyProofMock = jest.fn<boolean, [string, number, string]>();
  public onPongMock = jest.fn();

  constructor() {
    super({
      name: 'ipc',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 500,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 8000,
    });
  }

  protected async _sendRaw(serialized: string): Promise<void> {
    this.sent.push(JSON.parse(serialized));
  }

  public override verifyProof(nonce: string, ts: number, proof: string): boolean {
    return this.verifyProofMock(nonce, ts, proof);
  }

  public override onPong(): void {
    this.onPongMock();
    super.onPong();
  }
}

describe('IpcChildConsumer', () => {
  beforeEach(() => {
    (process as any).send = () => {};
  });

  afterEach(() => {
    (process as any).send = originalProcessSend;
    jest.restoreAllMocks();
    process.removeAllListeners('message');
  });

  it('throws in constructor when process.send is not defined', () => {
    (process as any).send = undefined;
    expect(() => new IpcChildConsumer({} as any, {} as any, { type: 'ipc' })).toThrow(
      'IPC transport requires running in a child process with IPC channel'
    );
  });

  it('handlePong calls onPong when token present and proof is valid', async () => {
    const producer = new StubProducer();
    const consumer = new IpcChildConsumer({} as any, producer, { type: 'ipc', token: 't' });
    producer.verifyProofMock.mockReturnValue(true);
    const payload: PongPayload = { ts: Date.now(), nonce: 'n', proof: 'p' };
    const message: Envelope<PongPayload> = { action: Actions.Pong, payload, timestamp: Date.now() };
    await consumer.onMessage(message);
    expect(producer.onPongMock).toHaveBeenCalledTimes(1);
  });

  it('handlePong does not call onPong when token present and proof invalid', async () => {
    const producer = new StubProducer();
    const consumer = new IpcChildConsumer({} as any, producer, { type: 'ipc', token: 't' });
    producer.verifyProofMock.mockReturnValue(false);
    const payload: PongPayload = { ts: Date.now(), nonce: 'n', proof: 'bad' };
    const message: Envelope<PongPayload> = { action: Actions.Pong, payload, timestamp: Date.now() };
    await consumer.onMessage(message);
    expect(producer.onPongMock).toHaveBeenCalledTimes(0);
  });

  it('handlePong calls onPong when token not provided or proof missing', async () => {
    const producer = new StubProducer();
    const consumer = new IpcChildConsumer({} as any, producer, { type: 'ipc' });
    const payload: PongPayload = { ts: Date.now() };
    const message: Envelope<PongPayload> = { action: Actions.Pong, payload, timestamp: Date.now() };
    await consumer.onMessage(message);
    expect(producer.onPongMock).toHaveBeenCalledTimes(1);

    const consumerWithToken = new IpcChildConsumer({} as any, producer, { type: 'ipc', token: 't' });
    const messageNoProof: Envelope<PongPayload> = { action: Actions.Pong, payload: { ts: Date.now(), nonce: 'n' }, timestamp: Date.now() };
    await consumerWithToken.onMessage(messageNoProof);
    expect(producer.onPongMock).toHaveBeenCalledTimes(2);
  });

  it('handleQueryMessage executes query and replies with same ids', async () => {
    const producer = new StubProducer();
    const consumer = new IpcChildConsumer({} as any, producer, { type: 'ipc' });
    const spy = jest.spyOn(consumer as any, 'executeQuery').mockResolvedValue({ ok: true });

    const incoming: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      payload: { name: 'Health', dto: { a: 1 } },
      requestId: 'rid-1',
      correlationId: 'cid-1',
      timestamp: Date.now(),
    };

    await consumer.onMessage(incoming);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(producer.sent.length).toBe(1);
    const out = producer.sent[0] as Envelope<QueryResponsePayload>;
    expect(out.action).toBe(Actions.QueryResponse);
    expect(out.requestId).toBe('rid-1');
    expect(out.correlationId).toBe('cid-1');
    expect(out.payload?.name).toBe('Health');
    expect(out.payload?.data).toEqual({ ok: true });
    expect(typeof out.timestamp).toBe('number');
  });

  it('handleQueryMessage sends error response on failure', async () => {
    const producer = new StubProducer();
    const consumer = new IpcChildConsumer({} as any, producer, { type: 'ipc' });
    jest.spyOn(consumer as any, 'executeQuery').mockRejectedValue(new Error('boom'));

    const incoming: Envelope<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      payload: { name: 'GetX', dto: { z: 1 } },
      requestId: 'r2',
      correlationId: 'c2',
      timestamp: Date.now(),
    };

    await consumer.onMessage(incoming);

    expect(producer.sent.length).toBe(1);
    const out = producer.sent[0] as Envelope<QueryResponsePayload>;
    expect(out.action).toBe(Actions.QueryResponse);
    expect(out.requestId).toBe('r2');
    expect(out.correlationId).toBe('c2');
    expect(out.payload?.name).toBe('GetX');
    expect(typeof out.payload?.err).toBe('string');
  });

  it('binds and unbinds process message listener', async () => {
    const producer = new StubProducer();
    const consumer = new IpcChildConsumer({} as any, producer, { type: 'ipc' });

    const before = process.listenerCount('message');

    const ping = JSON.stringify({ action: Actions.Ping });
    (process as any).emit('message', ping);

    expect(producer.sent.length).toBe(1);
    expect(producer.sent[0]!.action).toBe(Actions.Pong);

    await consumer.onModuleDestroy();

    const after = process.listenerCount('message');
    expect(after).toBeLessThanOrEqual(before);
  });
});
