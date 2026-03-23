import { Module, DynamicModule } from '@nestjs/common';
import { WsBrowserTransportService } from './ws-browser.service';
import type { WsBrowserClientOptions } from './ws-browser.service';

@Module({})
export class WsBrowserClientModule {
  static forRoot(opts: WsBrowserClientOptions): DynamicModule {
    return {
      module: WsBrowserClientModule,
      providers: [{ provide: WsBrowserTransportService, useFactory: () => new WsBrowserTransportService(opts) }],
      exports: [WsBrowserTransportService],
    };
  }
}
