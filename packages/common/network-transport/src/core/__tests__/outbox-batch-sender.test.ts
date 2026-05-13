import { OutboxBatchSender } from '../outbox-batch-sender';
import type { TransportPort } from '../transport-port';
import { Actions } from '../messages';

describe('OutboxBatchSender', () => {
  it('throws when transport is not set so callers can avoid writing outbox rows in local-only mode', async () => {
    const s = new OutboxBatchSender();
    expect(s.hasTransport()).toBe(false);
    await expect(
      s.streamWireWithAck([
        {
          modelName: 'User',
          eventType: 'Created',
          eventVersion: 1,
          requestId: 'r1',
          blockHeight: 1,
          payload: '{"id":1}',
          timestamp: Date.now(),
        },
      ])
    ).rejects.toThrow(/transport is not configured/i);
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
      waitForAck: jest.fn().mockImplementation(async (_deadline, correlationId) => ({ ok: true, okIndices: [0], correlationId })),
    };

    const s = new OutboxBatchSender();
    s.setTransport(fake);
    expect(s.hasTransport()).toBe(true);

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
    expect(fake.waitForAck).toHaveBeenCalledWith(undefined, expect.any(String));
    expect(calls[0].correlationId).toEqual(expect.any(String));
    expect(ack).toEqual({ ok: true, okIndices: [0], correlationId: expect.any(String) });
  });

  it('rejects partial ACK and keeps delivery as failed', async () => {
    const fake: TransportPort = {
      kind: 'ws',
      isOnline: () => true,
      waitForOnline: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      waitForAck: jest.fn().mockImplementation(async (_deadline, correlationId) => ({ ok: true, okIndices: [0], correlationId })),
    };

    const s = new OutboxBatchSender();
    s.setTransport(fake);

    await expect(
      s.streamWireWithAck([
        { modelName: 'User', eventType: 'Created', eventVersion: 1, requestId: 'r1', blockHeight: 1, payload: '{}', timestamp: 1 },
        { modelName: 'User', eventType: 'Updated', eventVersion: 2, requestId: 'r2', blockHeight: 2, payload: '{}', timestamp: 2 },
      ])
    ).rejects.toThrow(/partial/i);
  });

  it('serializes concurrent batch sends so ACK waiters cannot overwrite each other', async () => {
    const order: string[] = [];
    let releaseFirstAck: (() => void) | undefined;

    const fake: TransportPort = {
      kind: 'ws',
      isOnline: () => true,
      waitForOnline: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockImplementation(async (msg) => {
        order.push(`send:${msg.payload.events[0].requestId}`);
      }),
      waitForAck: jest.fn().mockImplementation(async (_deadline, correlationId) => {
        order.push(`ack-start:${correlationId}`);
        if (!releaseFirstAck) {
          await new Promise<void>((resolve) => {
            releaseFirstAck = resolve;
          });
        }
        order.push(`ack-done:${correlationId}`);
        return { ok: true, okIndices: [0], correlationId };
      }),
    };

    const s = new OutboxBatchSender();
    s.setTransport(fake);

    const first = s.streamWireWithAck([
      { modelName: 'User', eventType: 'Created', eventVersion: 1, requestId: 'r1', blockHeight: 1, payload: '{}', timestamp: 1 },
    ]);
    const second = s.streamWireWithAck([
      { modelName: 'User', eventType: 'Updated', eventVersion: 2, requestId: 'r2', blockHeight: 2, payload: '{}', timestamp: 2 },
    ]);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.send).toHaveBeenCalledTimes(1);
    releaseFirstAck?.();

    await first;
    await second;

    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(order[0]).toBe('send:r1');
    expect(order[3]).toBe('send:r2');
  });

});
