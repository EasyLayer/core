import { Module, DynamicModule, Logger } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { HttpTransportService } from './http.service';
import type { HttpServiceOptions } from './http.service';

@Module({})
export class HttpTransportModule {
  private static readonly logger = new Logger(HttpTransportModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: HttpServiceOptions): DynamicModule {
    this.logger.verbose('Starting network http-transport module registration', {
      module: this.moduleName,
    });

    return {
      module: HttpTransportModule,
      providers: [
        {
          provide: HttpTransportService,
          useFactory: (queryBus: QueryBus) => new HttpTransportService(opts, queryBus),
          inject: [QueryBus],
        },
      ],
      exports: [HttpTransportService],
    };
  }
}
