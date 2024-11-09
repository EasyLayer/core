import { Module, DynamicModule } from '@nestjs/common';
import { Repository } from './repository';
import { ConnectionManager } from './connection-manager';
import { SchemasManager } from './schemas-manager';
import { Schema } from './schema';

type OKMModuleConfig = {
  database: string;
  type: 'rocksdb'; // Now support only rocksdb
  schemas: Schema[];
};

@Module({})
export class OKMModule {
  static forRoot({ database, type, schemas }: OKMModuleConfig): DynamicModule {
    return {
      module: OKMModule,
      imports: [],
      providers: [
        {
          provide: ConnectionManager,
          useFactory: () => new ConnectionManager(database, type),
        },
        {
          provide: SchemasManager,
          useFactory: () => new SchemasManager(schemas),
        },
        Repository,
      ],
      exports: [ConnectionManager, SchemasManager, Repository],
    };
  }
}
