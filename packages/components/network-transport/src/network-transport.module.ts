import { Module, DynamicModule } from '@nestjs/common';
import { NETWORK_TRANSPORT_SERVICE } from '@easylayer/common/shared-interfaces';
import { NetworkTransportService } from './network-transport.service';

@Module({})
export class NetworkTransportModule {
  static forRoot(): DynamicModule {
    return {
      module: NetworkTransportModule,
      providers: [
        {
          provide: NETWORK_TRANSPORT_SERVICE,
          useClass: NetworkTransportService,
        },
      ],
      exports: [NETWORK_TRANSPORT_SERVICE],
    };
  }
}
