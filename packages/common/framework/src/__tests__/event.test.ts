import { BasicEvent as MockBasicEvent } from '@easylayer/common/cqrs';
import { makeNamedEventCtor, makeNamedEvent, clearEventFactoryCache } from '../event';

jest.mock('@easylayer/common/cqrs', () => {
  class BasicEvent {
    aggregateId: string;
    requestId: string;
    blockHeight: number;
    timestamp: number | undefined;
    payload: any;
    constructor(system: { aggregateId: string; requestId: string; blockHeight: number; timestamp?: number }, payload: any) {
      this.aggregateId = system.aggregateId;
      this.requestId = system.requestId;
      this.blockHeight = system.blockHeight;
      this.timestamp = system.timestamp;
      this.payload = payload;
    }
  }
  return { BasicEvent };
});

describe('event factory', () => {
  beforeEach(() => {
    clearEventFactoryCache();
    jest.clearAllMocks();
  });

  it('creates a constructor with the exact event name', () => {
    const eventName = 'UserCreated';
    const EventConstructor = makeNamedEventCtor(eventName);
    expect(typeof EventConstructor).toBe('function');
    expect(EventConstructor.name).toBe(eventName);
  });

  it('caches and returns the same constructor for the same event name', () => {
    const eventName = 'OrderPaid';
    const firstConstructor = makeNamedEventCtor(eventName);
    const secondConstructor = makeNamedEventCtor(eventName);
    expect(secondConstructor).toBe(firstConstructor);
  });

  it('returns different constructors for different event names', () => {
    const firstConstructor = makeNamedEventCtor('A');
    const secondConstructor = makeNamedEventCtor('B');
    expect(secondConstructor).not.toBe(firstConstructor);
  });

  it('constructs an instance that is instance of BasicEvent and preserves payload identity', () => {
    const eventName = 'CartUpdated';
    const EventConstructor = makeNamedEventCtor(eventName);
    const systemFields = { aggregateId: 'agg-1', requestId: 'req-1', blockHeight: 10, timestamp: 12345 };
    const payloadObject = { itemId: 'x', quantity: 2 };
    const instance = new EventConstructor(systemFields, payloadObject);
    expect(instance).toBeInstanceOf(MockBasicEvent as any);
    expect(instance.aggregateId).toBe('agg-1');
    expect(instance.requestId).toBe('req-1');
    expect(instance.blockHeight).toBe(10);
    expect(instance.timestamp).toBe(12345);
    expect(instance.payload).toBe(payloadObject);
  });

  it('makeNamedEvent creates an instance using the cached constructor', () => {
    const eventName = 'SessionStarted';
    const systemFields = { aggregateId: 'agg-9', requestId: 'req-9', blockHeight: 99, timestamp: 777 };
    const payloadObject = { userId: 'u1' };
    const instance = makeNamedEvent(eventName, systemFields, payloadObject);
    expect(instance).toBeInstanceOf(MockBasicEvent as any);
    expect(instance.aggregateId).toBe('agg-9');
    expect(instance.requestId).toBe('req-9');
    expect(instance.blockHeight).toBe(99);
    expect(instance.timestamp).toBe(777);
    expect(instance.payload).toBe(payloadObject);
    const cachedConstructor = makeNamedEventCtor(eventName);
    const secondInstance = new cachedConstructor(systemFields, payloadObject);
    expect(secondInstance.constructor).toBe((instance as any).constructor);
  });

  it('clearEventFactoryCache forces new constructor to be created', () => {
    const eventName = 'ProfileUpdated';
    const firstConstructor = makeNamedEventCtor(eventName);
    clearEventFactoryCache();
    const secondConstructor = makeNamedEventCtor(eventName);
    expect(secondConstructor).not.toBe(firstConstructor);
    expect(secondConstructor.name).toBe(eventName);
  });
});
