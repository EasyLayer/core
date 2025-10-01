import 'reflect-metadata';
import { EventBus } from '../event-bus';
import { BasicEvent } from '../basic-event';
import { EVENTS_HANDLER_METADATA } from '../constants';

class AEvent extends BasicEvent {}
class BEvent extends BasicEvent {}

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
});
