import { Actions } from '../../shared';
import type { WireEventRecord, Envelope } from '../../shared';
import type { BaseProducer } from '../base-producer';
import { OutboxStreamManager } from '../outbox-stream-manager';

function createMockProducer(ackValue: any = { allOk: true, okIndices: [0] }) {
  const calls: { sent?: Envelope; waitedOnlineMs?: number } = {};
  const waitForOnline = jest.fn(async (ms: number) => {
    calls.waitedOnlineMs = ms;
  });
  const sendMessage = jest.fn(async (envelope: Envelope) => {
    calls.sent = envelope;
  });
  const waitForAck = jest.fn(async (executor: () => Promise<void>) => {
    await executor();
    return ackValue;
  });

  const mock = {
    waitForOnline,
    sendMessage,
    waitForAck,
  } as unknown as BaseProducer;

  return { mock, calls, waitForOnline, sendMessage, waitForAck };
}

describe('OutboxStreamManager', () => {
  it('returns no-op success when producer is not set', async () => {
    const mgr = new OutboxStreamManager({} as any);
    const events: WireEventRecord[] = [];
    const ack = await mgr.streamWireWithAck(events);
    expect(ack).toEqual({ allOk: true, okIndices: [] });
  });

  it('waits for online, sends same events reference, and resolves ack from producer', async () => {
    const { mock, calls, waitForOnline, sendMessage, waitForAck } = createMockProducer({ allOk: true, okIndices: [0, 1] });
    const mgr = new OutboxStreamManager({} as any);
    mgr.setProducer(mock);

    const events: WireEventRecord[] = [
      { modelName: 'M', eventType: 'E', eventVersion: 1, requestId: 'r1', blockHeight: 1, payload: '{}', timestamp: 1 },
      { modelName: 'M2', eventType: 'E2', eventVersion: 2, requestId: 'r2', blockHeight: 2, payload: '{}', timestamp: 2 },
    ];

    const ack = await mgr.streamWireWithAck(events);

    expect(waitForOnline).toHaveBeenCalledTimes(1);
    expect(calls.waitedOnlineMs).toBe(5000);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(calls.sent?.action).toBe(Actions.OutboxStreamBatch);
    expect((calls.sent?.payload as any).events).toBe(events);
    expect(typeof calls.sent?.timestamp).toBe('number');

    expect(waitForAck).toHaveBeenCalledTimes(1);
    expect(ack).toEqual({ allOk: true, okIndices: [0, 1] });
  });

  it('propagates error when waitForOnline rejects', async () => {
    const { mock } = createMockProducer();
    (mock as any).waitForOnline = jest.fn(async () => { throw new Error('offline'); });

    const mgr = new OutboxStreamManager({} as any);
    mgr.setProducer(mock);

    await expect(mgr.streamWireWithAck([])).rejects.toThrow('offline');
  });

  it('propagates error when waitForAck rejects (e.g., ACK timeout)', async () => {
    const { mock, waitForAck } = createMockProducer();
    (waitForAck as jest.Mock).mockImplementationOnce(async (executor: () => Promise<void>) => {
      await executor();
      throw new Error('ACK timeout');
    });

    const mgr = new OutboxStreamManager({} as any);
    mgr.setProducer(mock);

    await expect(mgr.streamWireWithAck([])).rejects.toThrow('ACK timeout');
  });
});
