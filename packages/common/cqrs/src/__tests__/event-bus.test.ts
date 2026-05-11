import 'reflect-metadata';
import { EventBus } from '../event-bus';
import { BasicEvent } from '../basic-event';
import { EVENTS_HANDLER_METADATA } from '../constants';

class AEvent extends BasicEvent {}
class BEvent extends BasicEvent {}
class SlowEvent extends BasicEvent {}
class FastEvent extends BasicEvent {}

interface IEventHandler<E> { handle(event: E): any | Promise<any>; }

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

class FailingAHandler implements IEventHandler<AEvent> {
  async handle(event: AEvent) {
    if ((event as any).requestId === '9') {
      throw new Error('boom');
    }
  }
}

function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function tick() {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 1);
    })();
  });
}

describe('EventBus', () => {
  let bus: EventBus<any>;
  beforeEach(() => { bus = new EventBus(); });
  afterEach(() => { (bus as any).subject$.complete(); });

  it('publishes to handlers, preserves order, reports handler errors', async () => {
    const unhandled = { publish: jest.fn() };
    const commandBus = { execute: jest.fn(async () => {}) };
    bus.bindUnhandledBus(unhandled as any);
    bus.bindCommandBus(commandBus as any);

    const hA = new AHandler();
    const hB = new BHandler();
    const failing = new FailingAHandler();

    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [AEvent], AHandler);
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [BEvent], BHandler);
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [AEvent], FailingAHandler);

    bus.registerInstances([hA as any, hB as any, failing as any]);

    const events = [
      new AEvent({ aggregateId: 'x', requestId: '1', blockHeight: 1 }, {}),
      new BEvent({ aggregateId: 'x', requestId: '2', blockHeight: 2 }, {}),
      new AEvent({ aggregateId: 'x', requestId: '3', blockHeight: 3 }, {}),
    ];

    await bus.publishAll(events);

    await waitFor(() => hA.handled.length === 2 && hB.handled.length === 1);

    expect(hA.handled.map((e) => e.requestId)).toEqual(['1', '3']);
    expect(hB.handled.map((e) => e.requestId)).toEqual(['2']);

    await bus.publish(new AEvent({ aggregateId: 'y', requestId: '9', blockHeight: 1 }, {}));

    await waitFor(() => (unhandled.publish as any).mock.calls.length > 0);
    expect(unhandled.publish).toHaveBeenCalled();
  });

  // B4: registerInstances called twice must not create a duplicate subscription
  it('registerInstances called twice does not cause handler to run twice per event', async () => {
    let callCount = 0;

    class CountHandler implements IEventHandler<AEvent> {
      async handle(_event: AEvent) { callCount++; }
    }
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [AEvent], CountHandler);

    const handler = new CountHandler();
    bus.registerInstances([handler as any]);
    bus.registerInstances([handler as any]); // second call — must not create a second subscription

    await bus.publish(new AEvent({ aggregateId: 'x', requestId: '1', blockHeight: 1 }, {}));
    await new Promise((r) => setTimeout(r, 50));

    expect(callCount).toBe(1); // exactly once, not twice
  });

  // B7: handler timeout — stuck handler is aborted, stream continues
  it('routes timeout error to UnhandledExceptionBus and continues processing next event', async () => {
    const errors: any[] = [];
    const completed: string[] = [];

    bus.setHandlerTimeout(60); // 60 ms for test speed
    bus.bindUnhandledBus({ publish: (e: any) => errors.push(e) });

    class StuckHandler implements IEventHandler<SlowEvent> {
      async handle(_event: SlowEvent) {
        // Never resolves — simulates a hung handler
        await new Promise(() => {});
      }
    }
    class QuickHandler implements IEventHandler<FastEvent> {
      async handle(_event: FastEvent) { completed.push('fast'); }
    }

    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [SlowEvent], StuckHandler);
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [FastEvent], QuickHandler);

    bus.registerInstances([new StuckHandler() as any, new QuickHandler() as any]);

    await bus.publish(new SlowEvent({ aggregateId: 'x', requestId: 's1', blockHeight: 1 }, {}));
    await bus.publish(new FastEvent({ aggregateId: 'x', requestId: 'f1', blockHeight: 2 }, {}));

    // Wait for timeout (60 ms) plus processing margin
    await new Promise((r) => setTimeout(r, 250));

    expect(errors.length).toBe(1);
    expect(errors[0].exception.message).toMatch(/timed out after 60ms/);
    expect(completed).toContain('fast'); // stream continued after timeout
  });

  // B7: timeout disabled when handlerTimeoutMs = 0
  it('does not timeout when handlerTimeoutMs is set to 0', async () => {
    const errors: any[] = [];
    bus.setHandlerTimeout(0); // disabled
    bus.bindUnhandledBus({ publish: (e: any) => errors.push(e) });

    class SlowButOkHandler implements IEventHandler<AEvent> {
      async handle(_event: AEvent) {
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    Reflect.defineMetadata(EVENTS_HANDLER_METADATA, [AEvent], SlowButOkHandler);
    bus.registerInstances([new SlowButOkHandler() as any]);

    await bus.publish(new AEvent({ aggregateId: 'x', requestId: '1', blockHeight: 1 }, {}));
    await new Promise((r) => setTimeout(r, 150));

    expect(errors.length).toBe(0); // no timeout error
  });
});
