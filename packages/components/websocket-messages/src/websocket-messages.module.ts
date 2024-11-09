import { Module, DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@easylayer/components/cqrs';
import { WebsocketMessagesGateway } from './websocket-messages.gateway';

@Module({})
export class WebsocketMessagesModule {
  static async forRootAsync(parameters: any): Promise<DynamicModule> {
    return {
      module: WebsocketMessagesModule,
      global: parameters.isGlobal || false,
      imports: [CqrsModule.forRoot({})],
      providers: [WebsocketMessagesGateway],
      exports: [WebsocketMessagesGateway],
    };
  }
}
