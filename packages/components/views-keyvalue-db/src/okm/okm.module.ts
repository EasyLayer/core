import { Module, DynamicModule } from '@nestjs/common';
import { ConnectionManager, ConnectionOptions } from './connection-manager';
import { EntitiesManager, EntityClassOrSchema } from './entities-manager';
import { TransactionsRunner } from './transactions-runner';

export interface OKMModuleOptions extends ConnectionOptions {
  entities: EntityClassOrSchema[];
}

@Module({})
export class OKMModule {
  static forRoot({ entities, ...restOptions }: OKMModuleOptions): DynamicModule {
    return {
      module: OKMModule,
      imports: [],
      providers: [
        {
          provide: ConnectionManager,
          useFactory: () => new ConnectionManager(restOptions),
        },
        {
          provide: EntitiesManager,
          useFactory: (connectionManager) => new EntitiesManager(entities, connectionManager),
          inject: [ConnectionManager],
        },
        {
          provide: TransactionsRunner,
          useFactory: (connectionManager) => new TransactionsRunner(connectionManager),
          inject: [ConnectionManager],
        },
      ],
      exports: [ConnectionManager, EntitiesManager, TransactionsRunner],
    };
  }
}
