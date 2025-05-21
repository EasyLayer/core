import BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions, EntitySchema } from 'typeorm';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { ReadDatabaseService } from './secure-storage.service';

type SecureStorageModuleConfig = TypeOrmModuleOptions & {
  database: string;
  name: string;
  type: 'better-sqlite3';
  password: string;

  entities: (Function | EntitySchema<any>)[];
};

@Module({})
export class SecureStorageModule {
  static async forRootAsync(config: SecureStorageModuleConfig): Promise<DynamicModule> {
    const { name, entities = [], database, password, ...restOptions } = config;

    if (!password) {
      throw new Error();
    }

    const dataSourceOptions = {
      ...restOptions,
      database,
      entities,
      synchronize: false, // Disable synchronization by default
      driver: BetterSqlite3,
      prepareDatabase: (db: any) => {
        db.pragma(`cipher='sqlcipher'`);
        db.pragma(`key='${password}'`);
      },
    };

    const tempDataSource = new DataSource(dataSourceOptions);

    try {
      await tempDataSource.initialize();

      // TODO: check all tables and not just one
      const queryRunner = tempDataSource.createQueryRunner();
      const tableChecks = entities.map((entity) => queryRunner.hasTable(entity.constructor.name));

      const results = await Promise.all(tableChecks);

      const hasTables = results.every((exists) => exists);

      if (!hasTables) {
        // If any table is missing, enable synchronization
        dataSourceOptions.synchronize = true;
      }

      await tempDataSource.destroy();
    } catch (error) {
      dataSourceOptions.synchronize = true;
    }

    return {
      module: SecureStorageModule,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [LoggerModule.forRoot({ componentName: 'SecureStorage' })],
          name,
          useFactory: (log: AppLogger) => ({
            ...dataSourceOptions,
            log,
          }),
          inject: [AppLogger],
          dataSourceFactory: async (options?: DataSourceOptions & { log?: AppLogger }) => {
            if (!options) {
              throw new Error('Invalid options passed');
            }

            options.log?.info(`Connecting to read database...`);

            const dataSource = new DataSource(options);

            try {
              await dataSource.initialize();
            } catch (error) {
              options?.log?.error(`Unable to connect to the database ${name}`, { args: error });
            }

            options.log?.info(`Successfully connected to read database.`);

            return dataSource;
          },
        }),
        TypeOrmModule.forFeature(entities, name),
      ],
      providers: [
        {
          provide: ReadDatabaseService,
          useFactory: async (dataSource: DataSource) => {
            return new ReadDatabaseService(dataSource);
          },
          inject: [getDataSourceToken(name)],
        },
      ],
      exports: [TypeOrmModule, ReadDatabaseService],
    };
  }
}
