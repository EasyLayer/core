import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions, EntitySchema } from 'typeorm';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { ReadDatabaseService } from './read-database.service';

type ReadDatabaseModuleConfig = TypeOrmModuleOptions & {
  type: 'sqlite' | 'postgres' | 'mysql' | 'mongodb';
  name: string;
  // eslint-disable-next-line @typescript-eslint/ban-types
  entities: (Function | EntitySchema<any>)[];
  database: string;
};

@Module({})
export class ReadDatabaseModule {
  static async forRootAsync(config: ReadDatabaseModuleConfig): Promise<DynamicModule> {
    const { name, entities = [], database, ...restOptions } = config;

    const dataSourceOptions = {
      ...restOptions,
      name,
      database,
      entities,
      // IMPORTNAT: Disable synchronization by default
      synchronize: false,
    };

    return {
      module: ReadDatabaseModule,
      imports: [
        LoggerModule.forRoot({ componentName: 'ViewsDatabase' }),
        TypeOrmModule.forRootAsync({
          imports: [LoggerModule.forRoot({ componentName: 'ViewsDatabase' })],
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

            options.log?.info(`Connecting to read database...`, {}, this.constructor.name);

            const dataSource = new DataSource(options);

            try {
              await dataSource.initialize();
            } catch (error) {
              options.log?.error(`Unable to connect to the database ${database}`, error, this.constructor.name);
              throw error;
            }

            if (restOptions.type === 'sqlite') {
              await dataSource.query('PRAGMA cache_size = 2000;');
              await dataSource.query('PRAGMA temp_store = MEMORY;');
              await dataSource.query('PRAGMA mmap_size = 67108864;');
              await dataSource.query('PRAGMA synchronous = OFF;');
              await dataSource.query('PRAGMA journal_mode = WAL;');
              await dataSource.query('PRAGMA journal_size_limit = 67108864;');
              // await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE);');
            }

            options.log?.info(`Successfully connected to views database.`, {}, this.constructor.name);

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
