import "reflect-metadata";
import type { DomainEvent } from "../basic-event";
import { BasicEvent as BaseEvent } from "../basic-event";
import { CustomAggregateRoot } from "../custom-aggregate-root";

class TestEvent extends BaseEvent {}

type Snap = {
  map: Map<string, number>;
  set: Set<string>;
  date: Date;
  big: bigint;
  nested: { a: { b: { c: number } } };
  cyclic?: any;
  passthrough: { k: string };
};

class TestAggregate extends CustomAggregateRoot<DomainEvent> {
  state: Snap;

  static snapshotFieldAdapters = {
    "state.nested.a.b.c": {
      toJSON: (v: any) => v + 10,
      fromJSON: (r: any) => r - 10,
    },
    c: {
      toJSON: (v: any) => v + 1000,
      fromJSON: (r: any) => r - 1000,
    },
  };

  constructor(id: string, last: number, instanceAdapters?: any) {
    super(id, last, { snapshotAdapters: instanceAdapters });
    this.state = {
      map: new Map([["k", 1]]),
      set: new Set(["x", "y"]),
      date: new Date("2024-01-01T00:00:00.000Z"),
      big: 1234567890123456789n,
      nested: { a: { b: { c: 7 } } },
      passthrough: { k: "v" },
    };
    const node: any = { name: "root" };
    node.self = node;
    this.state.cyclic = node;
  }

  onTestEvent(e: TestEvent) {
    (this.state.map as any).set("h", e.payload.h ?? 0);
    (this as any)._lastBlockHeight = e.blockHeight;
    (this as any)._version = ((this as any)._version ?? 0) + 1;
  }
}

describe("CustomAggregateRoot", () => {
  it("JSON replacer/reviver round-trips Map/Set/Date/BigInt", () => {
    const a = new TestAggregate("id", 5);
    const snap = a.toSnapshot();
    const b = new TestAggregate("id", 5);
    b.fromSnapshot({ aggregateId: "id", version: 0, blockHeight: 5, payload: JSON.parse(snap) });
    expect(b.state.map instanceof Map).toBe(true);
    expect(b.state.set instanceof Set).toBe(true);
    expect(b.state.date instanceof Date).toBe(true);
    expect(typeof b.state.big === "bigint").toBe(true);
    expect(b.state.map.get("k")).toBe(1);
    expect([...b.state.set]).toEqual(["x", "y"]);
    expect(b.state.date.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(b.state.big).toBe(1234567890123456789n);
  });

  it("circular references are dropped and serialization completes", () => {
    const a = new TestAggregate("id", 5);
    const snap = a.toSnapshot();
    expect(typeof snap).toBe("string");
  });

  it("dot-path adapter has priority over key adapter", () => {
    const a = new TestAggregate("id", 5);
    const snap = a.toSnapshot();
    const payload = JSON.parse(snap);
    expect(payload.state.nested.a.b.c).toBe(17);
    const b = new TestAggregate("id", 5);
    b.fromSnapshot({ aggregateId: "id", version: 0, blockHeight: 5, payload });
    expect(b.state.nested.a.b.c).toBe(7);
  });

  it("instance adapters override static adapters", () => {
    const instanceAdapters = {
      "state.nested.a.b.c": {
        toJSON: (v: any) => v + 1,
        fromJSON: (r: any) => r - 1,
      },
    };
    const a = new TestAggregate("id", 5, instanceAdapters);
    const payload = JSON.parse(a.toSnapshot());
    expect(payload.state.nested.a.b.c).toBe(8);
    const b = new TestAggregate("id", 5, instanceAdapters);
    b.fromSnapshot({ aggregateId: "id", version: 0, blockHeight: 5, payload });
    expect(b.state.nested.a.b.c).toBe(7);
  });

  it("fields without adapters pass through unchanged", () => {
    const a = new TestAggregate("id", 5);
    const payload = JSON.parse(a.toSnapshot());
    expect(payload.state.passthrough).toEqual({ k: "v" });
  });

  it("on<Event> handler is called by apply", () => {
    const a = new TestAggregate("id", 1);
    const e = new TestEvent({ aggregateId: "id", requestId: "r", blockHeight: 2 }, { h: 42 });
    a.apply(e);
    expect(a.state.map.get("h")).toBe(42);
  });

  it("apply with fromHistory does not push to INTERNAL_EVENTS symbol", () => {
    const a = new TestAggregate("id", 1);
    const e = new TestEvent({ aggregateId: "id", requestId: "r", blockHeight: 3 }, { h: 1 });
    const before = a.getUnsavedEvents().length;
    a.apply(e, { fromHistory: true, skipHandler: false });
    const after = a.getUnsavedEvents().length;
    expect(after).toBe(before);
  });
});
