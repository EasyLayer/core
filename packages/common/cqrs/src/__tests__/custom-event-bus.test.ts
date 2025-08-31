import "reflect-metadata";
import { CommandBus, IEventHandler, UnhandledExceptionBus } from "@nestjs/cqrs";
import { EVENT_METADATA, EVENTS_HANDLER_METADATA, SAGA_METADATA } from "@nestjs/cqrs/dist/decorators/constants";
import { ModuleRef } from "@nestjs/core";
import { merge, Observable, Subject, throwError } from "rxjs";
import { delay, map } from "rxjs/operators";
import { CustomEventBus } from "../custom-event-bus";
import { BasicEvent } from "../basic-event";

class AEvent extends BasicEvent {}
class BEvent extends BasicEvent {}

class AHandler implements IEventHandler<AEvent> {
  handled: AEvent[] = [];
  async handle(event: AEvent) {
    await new Promise((r) => setTimeout(r, 20));
    this.handled.push(event);
  }
}

class BHandler implements IEventHandler<BEvent> {
  handled: BEvent[] = [];
  async handle(event: BEvent) {
    await new Promise((r) => setTimeout(r, 5));
    this.handled.push(event);
  }
}

describe("custom-event-bus.ts", () => {
  it("publishes to handlers, preserves order, reports handler errors", async () => {
    Reflect.defineMetadata(EVENT_METADATA, { id: AEvent.name }, AEvent);
    Reflect.defineMetadata(EVENT_METADATA, { id: BEvent.name }, BEvent);

    const moduleRef = { get: jest.fn(() => null) } as unknown as ModuleRef;
    const unhandled = { publish: jest.fn() } as unknown as UnhandledExceptionBus;
    const commandBus = { execute: jest.fn() } as unknown as CommandBus;
    const bus = new CustomEventBus(commandBus, moduleRef, unhandled);

    const hA = new AHandler();
    const hB = new BHandler();

    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [AEvent], AHandler);
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [BEvent], BHandler);

    bus.bind(hA as any, AEvent.name);
    bus.bind(hB as any, BEvent.name);

    const events = [
      new AEvent({ aggregateId: "x", requestId: "1", blockHeight: 1 }, {}),
      new BEvent({ aggregateId: "x", requestId: "2", blockHeight: 2 }, {}),
      new AEvent({ aggregateId: "x", requestId: "3", blockHeight: 3 }, {}),
    ];

    const done = new Promise<void>((resolve) => {
      let n = 0;
      const sub = bus.eventHandlerCompletion$.subscribe(() => {
        n++;
        if (n === events.length) {
          sub.unsubscribe();
          resolve();
        }
      });
    });

    await bus.publishAll(events);
    await done;

    expect(hA.handled.map((e) => e.requestId)).toEqual(["1", "3"]);
    expect(hB.handled.map((e) => e.requestId)).toEqual(["2"]);

    const failing: IEventHandler<AEvent> = {
      async handle() {
        throw new Error("boom");
      },
    };

    bus.bind(failing as any, AEvent.name);
    await bus.publish(new AEvent({ aggregateId: "y", requestId: "9", blockHeight: 1 }, {}));
    await new Promise((r) => setTimeout(r, 10));
    expect((unhandled.publish as any).mock.calls.length).toBeGreaterThan(0);
  });

  it("saga errors surface via sagaCompletion$", async () => {
    class SagaHolder {
      mySaga = (_eb: CustomEventBus) => {
        const s$ = new Subject<void>();
        const out$ = merge(
          s$.pipe(map(() => new AEvent({ aggregateId: "x", requestId: "1", blockHeight: 1 }, {})), delay(5)),
          throwError(() => new Error("saga-error"))
        );
        setTimeout(() => s$.next(), 0);
        return out$ as unknown as Observable<AEvent>;
      };
    }

    Reflect.defineMetadata(SAGA_METADATA, ["mySaga"], SagaHolder);

    const moduleRef = { get: jest.fn((t) => (t === SagaHolder ? new SagaHolder() : null)) } as unknown as ModuleRef;
    const unhandled = { publish: jest.fn() } as unknown as UnhandledExceptionBus;
    const commandBus = { execute: jest.fn() } as unknown as CommandBus;
    const bus = new CustomEventBus(commandBus, moduleRef, unhandled);

    bus.registerSagas([SagaHolder as any]);

    const gotError = new Promise<void>((resolve) => {
      bus.sagaCompletion$.subscribe({ error: () => resolve() });
    });

    await bus.publish(new AEvent({ aggregateId: "x", requestId: "0", blockHeight: 0 }, {}));
    await gotError;
  });
});
