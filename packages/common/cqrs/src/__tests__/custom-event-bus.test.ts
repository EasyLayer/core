import { CustomEventBus } from '../custom-event-bus';
import type { CommandBus, UnhandledExceptionBus } from '@nestjs/cqrs';
import type { ModuleRef } from '@nestjs/core';
import type { EventBasePayload } from '../basic-event';
import { BasicEvent } from '../basic-event';

class TestEvent extends BasicEvent<EventBasePayload> {
  constructor(public readonly payload: EventBasePayload) {
    super(payload);
  }
}

describe('CustomEventBus', () => {
  let eventBus: CustomEventBus;
  let mockCommandBus: jest.Mocked<CommandBus>;
  let mockModuleRef: jest.Mocked<ModuleRef>;
  let mockUnhandledExceptionBus: jest.Mocked<UnhandledExceptionBus>;

  beforeEach(() => {
    mockCommandBus = {
      execute: jest.fn(),
      register: jest.fn(),
    } as any;

    mockModuleRef = {
      get: jest.fn(),
    } as any;

    mockUnhandledExceptionBus = {
      publish: jest.fn(),
    } as any;

    eventBus = new CustomEventBus(mockCommandBus, mockModuleRef, mockUnhandledExceptionBus);
  });

  describe('publish()', () => {
    it('should publish single event', async () => {
      const event = new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' });
      const mockPublisher = { publish: jest.fn() };
      eventBus['publisher'] = mockPublisher as any;

      await eventBus.publish(event);

      expect(mockPublisher.publish).toHaveBeenCalledWith(event, undefined);
    });
  });

  describe('publishAll()', () => {
    it('should publish multiple events', async () => {
      const events = [
        new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
        new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
      ];
      const mockPublisher = { publishAll: jest.fn() };
      eventBus['publisher'] = mockPublisher as any;

      await eventBus.publishAll(events);

      expect(mockPublisher.publishAll).toHaveBeenCalledWith(events, undefined);
    });

    it('should fallback to single publish if publishAll not available', async () => {
      const events = [
        new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
        new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
      ];
      const mockPublisher = { publish: jest.fn() };
      eventBus['publisher'] = mockPublisher as any;

      await eventBus.publishAll(events);

      expect(mockPublisher.publish).toHaveBeenCalledTimes(2);
    });
  });
});
