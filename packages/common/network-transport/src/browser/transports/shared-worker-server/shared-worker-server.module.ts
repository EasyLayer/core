import { Module, DynamicModule } from '@nestjs/common';
import { QueryBus } from '@easylayer/common/cqrs';
import { SharedWorkerServerService } from './shared-worker-server.service';
import type { SharedWorkerServerOptions } from './shared-worker-server.service';

@Module({})
export class SharedWorkerServerModule {
  static forRoot(opts: SharedWorkerServerOptions): DynamicModule {
    return {
      module: SharedWorkerServerModule,
      providers: [
        {
          provide: SharedWorkerServerService,
          useFactory: (queryBus: QueryBus) => new SharedWorkerServerService(opts, queryBus),
          inject: [QueryBus],
        },
      ],
      exports: [SharedWorkerServerService],
    };
  }
}
