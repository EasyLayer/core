import "reflect-metadata";
import { Publisher } from "../publisher";

jest.mock("@easylayer/common/logger", () => ({
  AppLogger: class { debug(){} error(){} },
}));

jest.mock("@easylayer/common/cqrs", () => ({
  setEventMetadata: () => {},
}));

jest.mock("@easylayer/common/network-transport", () => ({
  OutboxStreamManager: class {
    calls: any[] = [];
    async streamWireWithAck(events: any[]) {
      this.calls.push(events);
    }
  },
}));

describe("Publisher", () => {
  it("streams to transport then emits only system events locally with correct constructor name", async () => {
    const { OutboxStreamManager } = require("@easylayer/common/network-transport");
    const { AppLogger } = require("@easylayer/common/logger");

    const pm = new OutboxStreamManager();
    const logger = new AppLogger();
    const system = ["sys-model"];
    const pub = new Publisher(pm as any, logger as any, system);

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

    await pub.publishWireStreamBatchWithAck([sysWire, nonSysWire]);

    await Promise.resolve();
    await Promise.resolve();

    expect(pm.calls.length).toBe(1);
    expect(pm.calls[0][0]).toMatchObject(sysWire);

    expect(got.length).toBe(1);
    expect(got[0].aggregateId).toBe("sys-model");
    expect(got[0].constructor?.name).toBe("UserCreated");
    expect(got[0].payload).toEqual({ a: 1 });

    sub.unsubscribe();
  });
});
