import { CustomAggregateRoot, EventStatus } from '../custom-aggregate-root';
import type { EventBasePayload } from '../basic-event';
import { BasicEvent } from '../basic-event';

class TestEvent extends BasicEvent<EventBasePayload> {
  constructor(public readonly payload: EventBasePayload) {
    super(payload);
  }
}

class TestAggregate extends CustomAggregateRoot<TestEvent> {
  public value: number = 0;

  private onTestEvent(event: TestEvent): void {
    this.value = this.value + event.payload.blockHeight;
  }
}

describe('CustomAggregateRoot', () => {
  let aggregate: TestAggregate;

  beforeEach(() => {
    aggregate = new TestAggregate('test-id');
  });

  describe('apply()', () => {
    it('should apply event and increment version', async () => {
      const event = new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' });
      await aggregate.apply(event);

      expect(aggregate.value).toBe(100);
      expect(aggregate.version).toBe(1);
      expect(aggregate.lastBlockHeight).toBe(100);
    });

    it('should not increment version when skipHandler is true', async () => {
      const event = new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' });
      await aggregate.apply(event, { skipHandler: true });

      expect(aggregate.value).toBe(0);
      expect(aggregate.version).toBe(0);
    });
  });

  describe('loadFromHistory()', () => {
    it('should load events from history in correct order', async () => {
      const events = [
        {
          event: new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
          status: EventStatus.PUBLISHED,
        },
        {
          event: new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
          status: EventStatus.PUBLISHED,
        },
      ];

      aggregate.loadFromHistory(events);

      expect(aggregate.value).toBe(200);
      expect(aggregate.version).toBe(2);
      expect(aggregate.lastBlockHeight).toBe(100);
    });
  });

  describe('loadFromSnapshot()', () => {
    it('should load state from snapshot', () => {
      const snapshot = {
        aggregateId: 'test-id',
        version: 5,
        blockHeight: 500,
        payload: {
          __type: 'TestAggregate',
          value: 500,
        },
      };

      aggregate.loadFromSnapshot(snapshot);

      expect(aggregate.aggregateId).toBe('test-id');
      expect(aggregate.version).toBe(5);
      expect(aggregate.lastBlockHeight).toBe(500);
      expect(aggregate.value).toBe(500);
    });

    it('should throw error when required fields are missing', () => {
      const invalidSnapshot = {
        aggregateId: '',
        version: 5,
        blockHeight: 500,
        payload: {},
      };

      expect(() => aggregate.loadFromSnapshot(invalidSnapshot)).toThrow('aggregate Id is missed');
    });
  });

  describe('commit() and uncommit()', () => {
    it('should save and commit events correctly', async () => {
      const event = new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' });
      
      // Apply event
      await aggregate.apply(event);
      expect(aggregate.getUnsavedEvents()).toHaveLength(1);
      expect(aggregate.getUncommittedEvents()).toHaveLength(0);
      
      // Mark as saved (simulate database save)
      aggregate.markEventsAsSaved();
      expect(aggregate.getUnsavedEvents()).toHaveLength(0);
      expect(aggregate.getUncommittedEvents()).toHaveLength(1);
      
      // Commit (publish and clear)
      await aggregate.commit();
      expect(aggregate.getUncommittedEvents()).toHaveLength(0);
    });
  });
});
