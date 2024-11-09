import { Module, DynamicModule } from '@nestjs/common';
import { LoggerModule } from '@easylayer/components/logger';
import { OKMModule, Schema } from './okm';
import { ViewsKeyValueDatabaseService } from './views-keyvalue-db.service';

type ViewsKeyValueDatabaseModuleConfig = {
  database: string;
  type: 'rocksdb';
  schemas: Schema[];
};

@Module({})
export class ViewsKeyValueDatabaseModule {
  static async forRootAsync(config: ViewsKeyValueDatabaseModuleConfig): Promise<DynamicModule> {
    const { database, type, schemas } = config;

    return {
      module: ViewsKeyValueDatabaseModule,
      imports: [
        LoggerModule.forRoot({ componentName: 'ViewsDatabase' }),
        OKMModule.forRoot({ database, type, schemas }),
      ],
      providers: [ViewsKeyValueDatabaseService],
      exports: [OKMModule, ViewsKeyValueDatabaseService],
    };
  }
}
