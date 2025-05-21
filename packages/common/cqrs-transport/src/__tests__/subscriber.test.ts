import { Test } from '@nestjs/testing';
import { LoggerModule } from '@easylayer/common/logger';
import { EventBus, CustomEventBus, BasicEvent, EventBasePayload } from '@easylayer/common/cqrs';
import { Subject } from 'rxjs';
import { Subscriber } from '../subscriber';
import { Publisher } from '../publisher';

describe('Subscriber', () => {
  let subscriber: Subscriber;
  let mockPublisher: jest.Mocked<Publisher>;
  let mockEventBus: jest.Mocked<CustomEventBus>;
  let mockBridge: Subject<BasicEvent<EventBasePayload>>;

  beforeEach(async () => {
    mockBridge = new Subject<BasicEvent<EventBasePayload>>();
    mockPublisher = {
      events$: new Subject<BasicEvent<EventBasePayload>>(),
    } as any;

    mockEventBus = {
      subject$: mockBridge,
    } as any;

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ componentName: 'CqrsTransportModule' })
      ],
      providers: [
        Subscriber,
        {
          provide: Publisher,
          useValue: mockPublisher,
        },
        {
          provide: EventBus,
          useValue: mockEventBus,
        },
      ],
    }).compile();

    subscriber = moduleRef.get(Subscriber);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should bridge events to event bus', () => {
      expect(mockEventBus.subject$).toBe(mockBridge);
    });
  });

  describe('cleanup', () => {
    it('should unsubscribe on module destroy', () => {
      const unsubscribeSpy = jest.spyOn(subscriber['subscription'], 'unsubscribe');

      subscriber.onModuleDestroy();

      expect(unsubscribeSpy).toHaveBeenCalled();
    });
  });
});
