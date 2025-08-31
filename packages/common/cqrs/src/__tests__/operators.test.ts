import { of, lastValueFrom } from "rxjs";
import { take, toArray, defaultIfEmpty } from "rxjs/operators";
import { executeWithRetry, executeWithRollback, ofType } from "../operators";
import { BasicEvent } from "../basic-event";

class Ev extends BasicEvent {}

describe("Operators", () => {
  it("executeWithRetry retries until success and re-emits input", async () => {
    jest.useFakeTimers({ now: Date.now() });

    let attempts = 0;
    const cmd = async () => {
      attempts++;
      if (attempts < 3) throw new Error("nope");
    };

    const src$ = of(new Ev({ aggregateId: "a", requestId: "r", blockHeight: 1 }, {})).pipe(
      executeWithRetry({ event: Ev, command: cmd }),
      take(1)
    );

    const p = lastValueFrom(src$);
    await jest.runAllTimersAsync();
    const out = await p;

    expect(out).toBeInstanceOf(Ev);
    expect(attempts).toBe(3);

    jest.useRealTimers();
  });

  it("executeWithRollback runs rollback and eventually errors after limit", async () => {
    jest.useFakeTimers({ now: Date.now() });

    const cmd = async () => {
      throw new Error("cmd-fail");
    };
    let rb = 0;
    const rollback = async () => {
      rb++;
      throw new Error("rb-fail");
    };

    const src$ = of(new Ev({ aggregateId: "a", requestId: "r", blockHeight: 1 }, {})).pipe(
      executeWithRollback({ event: Ev, command: cmd, rollback, retryOpt: { count: 2, delay: 10 } })
    );

    const p = new Promise<string>((resolve) => {
      const sub = src$.subscribe(
        () => {},
        (e) => {
          resolve(String(e?.message ?? e));
          sub.unsubscribe();
        },
        () => {
          resolve("completed");
          sub.unsubscribe();
        }
      );
    });

    await jest.runAllTimersAsync();
    const msg = await p;

    expect(msg).toMatch(/Retry limit exceeded|cmd-fail|rb-fail/);
    expect(rb).toBeGreaterThanOrEqual(1);

    jest.useRealTimers();
  });

  it("ofType filters by instanceof", async () => {
    const a = new Ev({ aggregateId: "a", requestId: "r", blockHeight: 1 }, {});
    const arr = await lastValueFrom(of(a).pipe(ofType(Ev), toArray()));
    expect(arr.length).toBe(1);
    expect(arr[0]).toBeInstanceOf(Ev);
  });

  it("ofType also matches by constructor.name", async () => {
    class Fake {
      constructor(public payload: any) {}
    }
    Object.defineProperty(Fake.prototype, "constructor", { value: { name: "Ev" } });
    const fake = new (Fake as any)({});

    const arr = await lastValueFrom(
      of(fake as any).pipe(ofType(Ev), defaultIfEmpty("EMPTY"), toArray())
    );

    expect(arr[0]).not.toBe("EMPTY");
  });
});
