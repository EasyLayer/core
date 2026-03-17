import { Module, DynamicModule, Logger } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { WsTransportService } from './ws.service';
import type { WsServiceOptions } from './ws.service';

@Module({})
export class WsTransportModule {
  private static readonly logger = new Logger(WsTransportModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: WsServiceOptions): DynamicModule {
    this.logger.verbose('Starting network ws-transport module registration', {
      module: this.moduleName,
    });

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
