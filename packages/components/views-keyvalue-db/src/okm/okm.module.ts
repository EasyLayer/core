import { Module, DynamicModule } from '@nestjs/common';
import { ConnectionManager, ConnectionOptions } from './connection-manager';
import { SchemasManager } from './schemas-manager';
import { EntitySchema } from './schema';
import { TransactionsRunner } from './transactions-runner';

export interface OKMModuleOptions extends ConnectionOptions {
  schemas: EntitySchema[];
}

@Module({})
export class OKMModule {
  static forRoot({ schemas, ...restOptions }: OKMModuleOptions): DynamicModule {
    return {
      module: OKMModule,
      imports: [],
      providers: [
        {
          provide: ConnectionManager,
          useFactory: () => new ConnectionManager(restOptions),
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
