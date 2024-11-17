import { Module, DynamicModule } from '@nestjs/common';
import { ConnectionManager } from './connection-manager';
import { SchemasManager } from './schemas-manager';
import { EntitySchema } from './schema';
import { TransactionsRunner } from './transactions-runner';

type OKMDatabaseType = 'rocksdb'; // Now support only rocksdb

export type OKMModuleConfig = {
  database: string;
  type: OKMDatabaseType;
  schemas: EntitySchema[];
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
          useFactory: (connectionManager) => new SchemasManager(schemas, connectionManager),
          inject: [ConnectionManager],
        },
        {
          provide: TransactionsRunner,
          useFactory: (connectionManager) => new TransactionsRunner(connectionManager),
          inject: [ConnectionManager],
        },
      ],
      exports: [ConnectionManager, SchemasManager, TransactionsRunner],
    };
  }
}
