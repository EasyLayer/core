import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { HttpTransportService } from './http.service';
import type { HttpServiceOptions } from './http.service';

@Module({})
export class HttpTransportModule {
  static forRoot(opts: HttpServiceOptions): DynamicModule {
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
