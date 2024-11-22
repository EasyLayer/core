import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/components/logger';
import { OKMModule, OKMModuleOptions } from './okm';
import { ViewsKeyValueDatabaseService } from './views-keyvalue-db.service';

type ViewsKeyValueDatabaseModuleConfig = OKMModuleOptions;

@Module({})
export class ViewsKeyValueDatabaseModule {
  static async forRootAsync(config: ViewsKeyValueDatabaseModuleConfig): Promise<DynamicModule> {
    return {
      module: ViewsKeyValueDatabaseModule,
      imports: [LoggerModule.forRoot({ componentName: 'ViewsDatabase' }), OKMModule.forRoot(config)],
      providers: [ViewsKeyValueDatabaseService],
      exports: [OKMModule, ViewsKeyValueDatabaseService],
    };
  }
}
