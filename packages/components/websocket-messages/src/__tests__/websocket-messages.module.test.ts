import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule } from '@easylayer/components/cqrs';
import { WebsocketMessagesModule } from '../websocket-messages.module';

describe('WebsocketMessagesModule', () => {
  let wsMessagesModule: WebsocketMessagesModule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule.forRoot({ isGlobal: true }), WebsocketMessagesModule],
    }).compile();

    wsMessagesModule = module.get<WebsocketMessagesModule>(WebsocketMessagesModule);
  });

  it('should be defined', () => {
    expect(wsMessagesModule).toBeDefined();
  });
});
