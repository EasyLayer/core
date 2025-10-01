import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { WsTransportService } from './ws.service';
import type { WsServiceOptions } from './ws.service';

@Module({})
export class WsTransportModule {
  static forRoot(opts: WsServiceOptions): DynamicModule {
    return {
      module: WsTransportModule,
      providers: [
        {
          provide: WsTransportService,
          useFactory: (queryBus: QueryBus) => new WsTransportService(opts, queryBus),
          inject: [QueryBus],
        },
      ],
      exports: [WsTransportService],
    };
  }
}
