import { BasicEvent, nowMicroseconds } from "../basic-event";

class TestEvent extends BasicEvent {}

describe("BasicEvent", () => {
  it("timestamp is strictly monotonic across two instances", () => {
    const e1 = new TestEvent(
      { aggregateId: "a", requestId: "r", blockHeight: 1 },
      { x: 1 }
    );
    const e2 = new TestEvent(
      { aggregateId: "a", requestId: "r", blockHeight: 2 },
      { x: 2 }
    );
    expect(e2.timestamp!).toBeGreaterThan(e1.timestamp!);
  });

  it("timestamp > Date.now()*1000 to avoid ms collapse", () => {
    const msBefore = Date.now() * 1000;
    const e = new TestEvent(
      { aggregateId: "a", requestId: "r", blockHeight: 1 },
      {}
    );
    expect(e.timestamp!).toBeGreaterThan(msBefore);
  });

  it("nowMicroseconds increases between subsequent calls", () => {
    const t1 = nowMicroseconds();
    const t2 = nowMicroseconds();
    expect(t2).toBeGreaterThan(t1);
  });
});
