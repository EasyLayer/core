import { Test } from '@nestjs/testing';
import { ProducersManager } from '@easylayer/common/network-transport';
import { LoggerModule } from '@easylayer/common/logger';
import { SystemEvent } from '@easylayer/common/cqrs';
import type { DomainEvent, SystemFields } from '@easylayer/common/cqrs';
import { Publisher } from '../publisher';

class TestEvent implements DomainEvent {
  aggregateId: string;
  requestId: string;
  blockHeight: number;

  constructor(
    public readonly payload: any,
    systemFields: SystemFields
  ) {
    this.aggregateId = systemFields.aggregateId;
    this.requestId = systemFields.requestId;
    this.blockHeight = systemFields.blockHeight;
  }
}

@SystemEvent()
class TestSystemEvent implements DomainEvent {
  aggregateId: string;
  requestId: string;
  blockHeight: number;

  constructor(
    public readonly payload: any,
    systemFields: SystemFields
  ) {
    this.aggregateId = systemFields.aggregateId;
    this.requestId = systemFields.requestId;
    this.blockHeight = systemFields.blockHeight;
  }
}

describe('Publisher', () => {
  let publisher: Publisher;
  let mockProducersManager: jest.Mocked<ProducersManager>;

  beforeEach(async () => {
    mockProducersManager = {
      broadcast: jest.fn().mockResolvedValue(undefined),
    } as any;

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ componentName: 'CqrsTransportModule' })
      ],
      providers: [
        Publisher,
        {
          provide: ProducersManager,
          useValue: mockProducersManager,
        },
      ],
    }).compile();

    publisher = moduleRef.get(Publisher);
  });

  describe('publish()', () => {
    it('should broadcast event to external transport', async () => {
      const event = new TestEvent({}, { aggregateId: 'uniq', blockHeight: 100, requestId: '123' });
      await publisher.publish(event);

      expect(mockProducersManager.broadcast).toHaveBeenCalledWith([event]);
    });

    it('should publish system event to local transport after external broadcast', async () => {
      const event = new TestSystemEvent({}, { aggregateId: 'uniq2', blockHeight: 100, requestId: '123' });
      const eventsSpy = jest.spyOn(publisher['subject$'], 'next');

      await publisher.publish(event);

      expect(mockProducersManager.broadcast).toHaveBeenCalledWith([event]);
      expect(eventsSpy).toHaveBeenCalledWith(event);
    });

    // it('should not publish non-system event to local transport', async () => {
    //   const event = new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' });
    //   const eventsSpy = jest.spyOn(publisher['subject$'], 'next');

    //   await publisher.publish(event);

    //   expect(mockProducersManager.broadcast).toHaveBeenCalledWith([event]);
    //   expect(eventsSpy).not.toHaveBeenCalled();
    // });
  });

  describe('publishAll()', () => {
    it('should broadcast all events to external transport', async () => {
      const events = [
        new TestEvent({}, { aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
        new TestSystemEvent({}, { aggregateId: 'uniq2', blockHeight: 100, requestId: '123' }),
      ];

      await publisher.publishAll(events);

      expect(mockProducersManager.broadcast).toHaveBeenCalledWith(events);
    });

    // it('should publish only system events to local transport', async () => {
    //   const events = [
    //     new TestEvent({ aggregateId: 'uniq', blockHeight: 100, requestId: '123' }),
    //     new TestSystemEvent({ aggregateId: 'uniq2', blockHeight: 100, requestId: '123' }),
    //   ];
    //   const eventsSpy = jest.spyOn(publisher['subject$'], 'next');

    //   await publisher.publishAll(events);

    //   expect(mockProducersManager.broadcast).toHaveBeenCalledWith(events);
    //   expect(eventsSpy).toHaveBeenCalledTimes(1);
    //   expect(eventsSpy).toHaveBeenCalledWith(events[1]); // TestSystemEvent
    // });
  });
});
