import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/components/logger';
import { OKMModule, OKMModuleConfig } from './okm';
import { ViewsKeyValueDatabaseService } from './views-keyvalue-db.service';

export type ViewsKeyValueDatabaseModuleConfig = OKMModuleConfig;

@Module({})
export class ViewsKeyValueDatabaseModule {
  static async forRootAsync(config: ViewsKeyValueDatabaseModuleConfig): Promise<DynamicModule> {
    const { ...restOptions } = config;

    return {
      module: ViewsKeyValueDatabaseModule,
      imports: [LoggerModule.forRoot({ componentName: 'ViewsDatabase' }), OKMModule.forRoot({ ...restOptions })],
      providers: [ViewsKeyValueDatabaseService],
      exports: [OKMModule, ViewsKeyValueDatabaseService],
    };
  }
}
