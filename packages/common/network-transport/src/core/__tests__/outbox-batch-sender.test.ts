import { OutboxBatchSender } from '../outbox-batch-sender';
import type { TransportPort } from '../transport-port';
import { Actions } from '../messages';

describe('OutboxBatchSender', () => {
  it('returns immediately when transport is not set', async () => {
    const s = new OutboxBatchSender();
    const ack = await s.streamWireWithAck([
      {
        modelName: 'User',
        eventType: 'Created',
        eventVersion: 1,
        requestId: 'r1',
        blockHeight: 1,
        payload: '{"id":1}',
        timestamp: Date.now(),
      },
    ]);
    expect(ack).toEqual({ ok: true, okIndices: [] });
  });

  it('waits for online, sends batch and waits for ack', async () => {
    const calls: any[] = [];
    const fake: TransportPort = {
      kind: 'ws',
      isOnline: () => true,
      waitForOnline: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockImplementation(async (msg) => {
        calls.push(msg);
      }),
      waitForAck: jest.fn().mockResolvedValue({ ok: true, okIndices: [0] }),
    };

    const s = new OutboxBatchSender();
    s.setTransport(fake);

    const ack = await s.streamWireWithAck([
      {
        modelName: 'User',
        eventType: 'Created',
        eventVersion: 1,
        requestId: 'r1',
        blockHeight: 1,
        payload: '{"id":1}',
        timestamp: 111,
      },
    ]);

    expect(fake.waitForOnline).toHaveBeenCalled();
    expect(fake.send).toHaveBeenCalled();
    expect(calls[0].action).toBe(Actions.OutboxStreamBatch);
    expect(Array.isArray(calls[0].payload.events)).toBe(true);
    expect(ack).toEqual({ ok: true, okIndices: [0] });
  });
});
