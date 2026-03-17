import { Module, DynamicModule, Logger } from '@nestjs/common';
import { HttpBrowserService } from './http-browser.service';
import type { HttpBrowserClientOptions } from './http-browser.service';

@Module({})
export class HttpBrowserClientModule {
  private static readonly logger = new Logger(HttpBrowserClientModule.name);
  private static readonly moduleName = 'network-transport';

  static forRoot(opts: HttpBrowserClientOptions): DynamicModule {
    this.logger.verbose('Starting network http-browser-transport module registration', {
      module: this.moduleName,
    });

    return {
      module: HttpBrowserClientModule,
      providers: [{ provide: HttpBrowserService, useFactory: () => new HttpBrowserService(opts) }],
      exports: [HttpBrowserService],
    };
  }
}
