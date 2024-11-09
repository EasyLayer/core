import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions, getDataSourceToken } from '@nestjs/typeorm';
import { RdbmsSchemaBuilder } from 'typeorm/schema-builder/RdbmsSchemaBuilder';
import { DataSource, DataSourceOptions, EntitySchema, QueryRunner } from 'typeorm';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { ReadDatabaseService } from './read-database.service';

type ReadDatabaseModuleConfig = TypeOrmModuleOptions & {
  type: 'sqlite' | 'postgres' | 'mysql' | 'mongodb';
  name: string;
  // eslint-disable-next-line @typescript-eslint/ban-types
  entities: (Function | EntitySchema<any>)[];
  database: string;
  unlogged?: boolean;
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
      synchronize: false, // Disable synchronization by default
    };

    const tempDataSource = new DataSource(dataSourceOptions);

    try {
      await tempDataSource.initialize();

      const queryRunner = tempDataSource.createQueryRunner();
      const tableChecks = entities.map((entity) => queryRunner.hasTable(entity.constructor.name));

      const results = await Promise.all(tableChecks);

      const hasTables = results.every((exists) => exists);

      if (!hasTables) {
        // If any table is missing, enable synchronization
        dataSourceOptions.synchronize = true;

        // IMPORTANT: In case of Postgres we can use UNLOGGED tables to improve performance.
        // To do this, we dynamically read the schemes that the developer passed on and change them.
        if (restOptions.type === 'postgres' && restOptions.unlogged) {
          const sqlQueries = await getSQLFromEntitySchema(tempDataSource);

          // Modifying queries to add UNLOGGED
          const unloggedSqlQueries = sqlQueries.map((query) => {
            if (query.query.startsWith('CREATE TABLE')) {
              return query.query.replace('CREATE TABLE', 'CREATE UNLOGGED TABLE');
            }
            // We do not change other queries
            return query.query;
          });

          // Executing modified SQL queries
          for (const sql of unloggedSqlQueries) {
            await queryRunner.query(sql);
          }
        }
      }

      await tempDataSource.destroy();
    } catch (error) {
      dataSourceOptions.synchronize = true;
    }

    return {
      module: ReadDatabaseModule,
      imports: [
        LoggerModule.forRoot({ componentName: 'ViewsDatabase' }),
        TypeOrmModule.forRootAsync({
          imports: [LoggerModule.forRoot({ componentName: 'ViewsDatabase' })],
          name,
          useFactory: (log: AppLogger) => ({
            ...dataSourceOptions,
            ...(restOptions.type === 'postgres' ? { pollSize: 30 } : {}),
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

async function getSQLFromEntitySchema(dataSource: DataSource): Promise<any[]> {
  const queryRunner: QueryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();

    // Using SchemaBuilder to Generate SQL
    const schemaBuilder = new RdbmsSchemaBuilder(dataSource);

    const sqlQueries = await schemaBuilder.log();
    return sqlQueries.upQueries;
  } catch (error) {
    throw error;
  } finally {
    await queryRunner.release();
  }
}
