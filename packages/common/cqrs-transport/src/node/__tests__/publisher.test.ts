import "reflect-metadata";
import { Logger } from '@nestjs/common';
import { Publisher } from "../publisher";

jest.mock("@easylayer/common/cqrs", () => ({
  setEventMetadata: () => {},
}));

jest.mock("@easylayer/common/network-transport", () => ({
  OutboxBatchSender: class {
    calls: any[] = [];
    hasTransport() { return true; }
    async streamWireWithAck(events: any[]) {
      this.calls.push(events);
      return { ok: true, okIndices: events.map((_, index) => index) };
    }
  },
}));

describe("Publisher", () => {
  it('hasRemoteTransport reflects OutboxBatchSender configuration', () => {
    const { OutboxBatchSender } = require('@easylayer/common/network-transport');
    const pm = new OutboxBatchSender();
    const logger = new Logger();
    const pub = new Publisher(pm as any, logger as any, []);

    expect(pub.hasRemoteTransport()).toBe(true);
  });

  it("streams to external transport without local system event emission", async () => {
    const { OutboxBatchSender } = require("@easylayer/common/network-transport");

    const pm = new OutboxBatchSender();
    const logger = new Logger();
    const pub = new Publisher(pm as any, logger as any, ["sys-model"]);

    const got: any[] = [];
    const sub = pub.events$.subscribe((e) => got.push(e));

    const sysWire = {
      modelName: "sys-model",
      eventType: "UserCreated",
      eventVersion: 1,
      requestId: "r1",
      blockHeight: 10,
      payload: JSON.stringify({ a: 1 }),
      timestamp: Date.now(),
    };
    const nonSysWire = { ...sysWire, modelName: "external" };

    const ack = await pub.publishWireStreamBatchWithAck([sysWire, nonSysWire]);

    expect(ack).toEqual({ ok: true, okIndices: [0, 1] });

    await Promise.resolve();
    await Promise.resolve();

    expect(pm.calls.length).toBe(1);
    expect(pm.calls[0][0]).toMatchObject(sysWire);
    expect(got.length).toBe(0);

    sub.unsubscribe();
  });

  it('publishSystemEventsLocally: schedules local emit for system events only', async () => {
    const { OutboxBatchSender } = require('@easylayer/common/network-transport');

    const order: string[] = [];
    const origQM = global.queueMicrotask;

    global.queueMicrotask = (cb: () => void) => {
      order.push('scheduled-local');
      return origQM.call(global, () => {
        order.push('executed-local');
        cb();
      }) as any;
    };

    const pm = new OutboxBatchSender();
    const logger = new (require('@nestjs/common').Logger)();
    const pub = new (require('../publisher').Publisher)(pm as any, logger as any, ['sys-model']);

    const got: any[] = [];
    const sub = pub.events$.subscribe((e: any) => got.push(e));

    const sysWire = {
      modelName: 'sys-model',
      eventType: 'UserCreated',
      eventVersion: 1,
      requestId: 'r1',
      blockHeight: 10,
      payload: JSON.stringify({ a: 1 }),
      timestamp: Date.now(),
    };
    const nonSysWire = { ...sysWire, modelName: 'external' };

    pub.publishSystemEventsLocally([sysWire, nonSysWire]);

    expect(order[0]).toBe('scheduled-local');
    expect(pm.calls.length).toBe(0);

    await Promise.resolve();
    expect(order).toContain('executed-local');
    expect(got.length).toBe(1);
    expect(got[0].aggregateId).toBe('sys-model');
    expect(got[0].constructor?.name).toBe('UserCreated');
    expect(got[0].payload).toEqual({ a: 1 });

    sub.unsubscribe();
    global.queueMicrotask = origQM;
  });
});
