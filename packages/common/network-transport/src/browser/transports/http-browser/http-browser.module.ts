import { Module, DynamicModule } from '@nestjs/common';
import { HttpBrowserService } from './http-browser.service';
import type { HttpBrowserClientOptions } from './http-browser.service';

@Module({})
export class HttpBrowserClientModule {
  static forRoot(opts: HttpBrowserClientOptions): DynamicModule {
    return {
      module: HttpBrowserClientModule,
      providers: [{ provide: HttpBrowserService, useFactory: () => new HttpBrowserService(opts) }],
      exports: [HttpBrowserService],
    };
  }
}
