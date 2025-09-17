import { Actions } from '../../../shared';
import type { Envelope } from '../../../shared';
import { IpcChildProducer } from '../ipc-child.producer';
import { createHmac, randomBytes } from 'node:crypto';

const originalProcessSend = (process as any).send;
const originalProcessConnected = (process as any).connected;

describe('IpcChildProducer', () => {
  beforeEach(() => {
    (process as any).send = jest.fn();
    (process as any).connected = true;
    process.removeAllListeners('message');
  });

  afterEach(() => {
    (process as any).send = originalProcessSend;
    (process as any).connected = originalProcessConnected;
    process.removeAllListeners('message');
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('isUnderlyingConnected depends on process.connected and process.send', () => {
    const p = new IpcChildProducer({
      name: 'ipc',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 500,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 8000,
    });
    (process as any).connected = true;
    (process as any).send = jest.fn();
    expect((p as any)._isUnderlyingConnected()).toBe(true);
    (process as any).connected = false;
    expect((p as any)._isUnderlyingConnected()).toBe(false);
    (process as any).connected = true;
    (process as any).send = undefined;
    expect((p as any)._isUnderlyingConnected()).toBe(false);
  });

  it('startHeartbeat sends ping with nonce and allows proof verification once', async () => {
    const p = new IpcChildProducer({
      name: 'ipc',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 500,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 8000,
      token: 'secret',
    });
    p.startHeartbeat();
    await new Promise((r) => setTimeout(r, 0));
    expect((process as any).send).toHaveBeenCalled();

    const callArg = ((process as any).send as jest.Mock).mock.calls.pop()[0];
    const ping = typeof callArg === 'string' ? JSON.parse(callArg) : callArg;
    expect(ping.action).toBe(Actions.Ping);
    const nonce: string = ping.payload?.nonce;
    const ts: number = ping.payload?.ts;

    const proof = createHmac('sha256', 'secret').update(`${nonce}|${ts}`).digest('hex');
    expect(p.verifyProof(nonce, ts, proof)).toBe(true);
    expect(p.verifyProof(nonce, ts, proof)).toBe(false);

    p.stopHeartbeat();
  });

  it('resolves ACK on OutboxStreamAck process message', async () => {
    const p = new IpcChildProducer({
      name: 'ipc',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 300,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 8000,
    });
    const envelope: Envelope = { action: Actions.OutboxStreamBatch, payload: { events: [] } };
    const pending = p.waitForAck(async () => {
      await (p as any)._sendSerialized(envelope);
      setTimeout(() => {
        const ack = { action: Actions.OutboxStreamAck, payload: { allOk: true, okIndices: [] } };
        (process as any).emit('message', JSON.stringify(ack));
      }, 0);
    });
    await expect(pending).resolves.toEqual({ allOk: true, okIndices: [] });
  });

  it('updates connection on Pong process message', async () => {
    jest.useFakeTimers();
    const p = new IpcChildProducer({
      name: 'ipc',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 300,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 100,
    });
    expect(p.isConnected()).toBe(true);
    const pong = { action: Actions.Pong, payload: { ts: Date.now() } };
    (process as any).emit('message', JSON.stringify(pong));
    expect(p.isConnected()).toBe(true);
    jest.advanceTimersByTime(150);
    expect(p.isConnected()).toBe(false);
  });

  it('_sendRaw uses process.send with serialized string', async () => {
    const p = new IpcChildProducer({
      name: 'ipc',
      maxMessageBytes: 1024 * 1024,
      ackTimeoutMs: 300,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 8000,
    });
    const e: Envelope = { action: 'x', payload: { a: 1 } };
    await (p as any)._sendSerialized(e);
    expect((process as any).send).toHaveBeenCalled();
    const arg = ((process as any).send as jest.Mock).mock.calls[0][0];
    const parsed = JSON.parse(arg);
    expect(parsed.action).toBe('x');
    expect(parsed.payload).toEqual({ a: 1 });
  });
});
