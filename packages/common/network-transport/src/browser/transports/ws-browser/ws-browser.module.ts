import { Module, DynamicModule, Logger } from '@nestjs/common';
import { WsBrowserTransportService } from './ws-browser.service';
import type { WsBrowserClientOptions } from './ws-browser.service';

@Module({})
export class WsBrowserClientModule {
  private static readonly logger = new Logger(WsBrowserClientModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: WsBrowserClientOptions): DynamicModule {
    this.logger.verbose('Starting network ws-browser-transport module registration', {
      module: this.moduleName,
    });

    return {
      module: WsBrowserClientModule,
      providers: [{ provide: WsBrowserTransportService, useFactory: () => new WsBrowserTransportService(opts) }],
      exports: [WsBrowserTransportService],
    };
  }
}
