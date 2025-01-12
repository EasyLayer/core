import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { addTransactionalDataSource, initializeTransactionalContext } from 'typeorm-transactional';
import { DataSource, DataSourceOptions } from 'typeorm';
import { LoggerModule, AppLogger } from '@easylayer/components/logger';
import { EventDataModel } from './event-data.model';
import { SnapshotsModel } from './snapshots.model';
import { EventStoreRepository } from './eventstore.repository';
import { EventStoreService } from './eventstore.service';

type EventStoreConfig = TypeOrmModuleOptions & {
  type: 'sqlite' | 'postgres';
  name: string;
  database: string;
};

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    const { name, database, ...restOptions } = config;

    // Initialize transactional context before setting up the database connections
    initializeTransactionalContext();

    const dataSourceOptions = {
      ...restOptions,
      name,
      database,
      entities: [EventDataModel, SnapshotsModel],
      synchronize: false, // Disable synchronization by default
    };

    const tempDataSource = new DataSource(dataSourceOptions);

    try {
      await tempDataSource.initialize();

      // Checking for the presence of tables
      const queryRunner = tempDataSource.createQueryRunner();
      const hasTables = await queryRunner.hasTable(EventDataModel.constructor.name);

      if (!hasTables) {
        // If there are no tables, enable synchronization
        dataSourceOptions.synchronize = true;
      }

      await tempDataSource.destroy();
    } catch (error) {
      dataSourceOptions.synchronize = true;
    }

    return {
      module: EventStoreModule,
      imports: [
        LoggerModule.forRoot({ componentName: 'EventStore' }),
        // IMPORTANT: 'name' - is required everywhere and for convenience we indicate it the same
        // so as not to get confused. It must be unique to the one module connection.
        TypeOrmModule.forRootAsync({
          imports: [LoggerModule.forRoot({ componentName: 'EventStore' })],
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

            options.log?.info(`Connecting to eventstore...`, {}, this.constructor.name);

            const dataSource = new DataSource(options);
            await dataSource.initialize();

            // TODO: move its somewhere
            // Apply PRAGMA settings (for improve writing) for SQLite
            if (restOptions.type === 'sqlite') {
              await dataSource.query('PRAGMA cache_size = 2000;'); // ~8 МБ
              await dataSource.query('PRAGMA temp_store = MEMORY;'); // DEFAULT
              await dataSource.query('PRAGMA locking_mode = EXCLUSIVE;');
              await dataSource.query('PRAGMA mmap_size = 67108864;'); // 64 МБ

              await dataSource.query('PRAGMA synchronous = OFF;');
              await dataSource.query('PRAGMA journal_mode = WAL;');
              await dataSource.query('PRAGMA journal_size_limit = 67108864;'); // 64 МБ // 6144000 - 6 МБ

              // await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE);');
            }

            // Add a DataSource with a unique name
            // IMPORTANT: name use in @Transactional() decorator
            addTransactionalDataSource({
              name,
              dataSource,
            });

            options.log?.info(`Successfully connected to eventstore.`, {}, this.constructor.name);

            return dataSource;
          },
        }),
      ],
      providers: [
        {
          provide: EventStoreRepository,
          useFactory: async (logger, eventsRepository, snapshotsRepository) => {
            return new EventStoreRepository(logger, eventsRepository, snapshotsRepository, name);
          },
          inject: [AppLogger, 'EVENT_DATA_MODEL_REPOSITORY', 'SNAPSHOTS_MODEL_REPOSITORY'],
        },
        {
          provide: EventStoreService,
          useFactory: async (dataSource: DataSource) => {
            return new EventStoreService(dataSource);
          },
          inject: [getDataSourceToken(name)],
        },
        {
          provide: 'EVENT_DATA_MODEL_REPOSITORY',
          useFactory: async (dataSource: DataSource) => dataSource.getRepository(EventDataModel),
          inject: [getDataSourceToken(name)],
        },
        {
          provide: 'SNAPSHOTS_MODEL_REPOSITORY',
          useFactory: async (dataSource: DataSource) => dataSource.getRepository(SnapshotsModel),
          inject: [getDataSourceToken(name)],
        },
      ],
      exports: [EventStoreRepository, EventStoreService],
    };
  }
}
