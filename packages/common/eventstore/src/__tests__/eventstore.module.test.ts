import { Test, TestingModule } from '@nestjs/testing';
import { EventStoreModule } from '../node/eventstore.module';

describe('EventStoreModule', () => {
  let eventStoreModule: EventStoreModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [EventStoreModule],
    }).compile();

    eventStoreModule = module.get<EventStoreModule>(EventStoreModule);
  });

  it('should be defined', () => {
    expect(eventStoreModule).toBeDefined();
  });
});
