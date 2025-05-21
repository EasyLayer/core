import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { addTransactionalDataSource, initializeTransactionalContext } from 'typeorm-transactional';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { AggregateRoot } from '@easylayer/common/cqrs';
import { ContextModule, ContextService } from '@easylayer/common/context';
import { createSnapshotsEntity } from './snapshots.model';
import { createEventDataEntity } from './event-data.model';
import { EventStoreWriteRepository } from './eventstore-write.repository';
import { EventStoreReadRepository } from './eventstore-read.repository';
import { EventStoreService } from './eventstore.service';

type EventStoreConfig = TypeOrmModuleOptions & {
  type: 'sqlite' | 'postgres';
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  snapshotInterval?: number;
  sqliteBatchSize?: number;
};

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    const { name, database, aggregates, snapshotInterval, ...restOptions } = config;

    // Initialize transactional context before setting up the database connections
    initializeTransactionalContext();

    const snapshotEntity = createSnapshotsEntity();

    // Dynamically creating schemas from aggregates
    const dynamicEntities = aggregates.map((agg) => createEventDataEntity(agg.aggregateId, config.type));

    const entities = [...dynamicEntities, snapshotEntity];

    const dataSourceOptions = {
      ...restOptions,
      name,
      entities,
      synchronize: false, // Disable synchronization by default
      database: database, //config.type === 'sqlite' ? `${database}.db` : database,
    };

    const tempDataSource = new DataSource(dataSourceOptions);

    try {
      await tempDataSource.initialize();

      // Checking for the presence of tables
      const queryRunner = tempDataSource.createQueryRunner();
      for (const entity of entities) {
        const tableName = entity.options?.tableName || entity.constructor.name;
        const hasTable = await queryRunner.hasTable(tableName);

        if (!hasTable) {
          // If there are no tables, enable synchronization
          dataSourceOptions.synchronize = true;
        }
      }
      await queryRunner.release();
      await tempDataSource.destroy();
    } catch (error) {
      dataSourceOptions.synchronize = true;
    }

    return {
      module: EventStoreModule,
      imports: [
        ContextModule,
        LoggerModule.forRoot({ componentName: EventStoreModule.name }),
        // IMPORTANT: 'name' - is required everywhere and for convenience we indicate it the same
        // so as not to get confused. It must be unique to the one module connection.
        TypeOrmModule.forRootAsync({
          imports: [LoggerModule.forRoot({ componentName: EventStoreModule.name })],
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

            options.log?.info(`Connecting to eventstore...`);

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

            options.log?.info(`Successfully connected to eventstore.`);

            return dataSource;
          },
        }),
      ],
      providers: [
        {
          provide: EventStoreReadRepository,
          useFactory: async (logger, dataSource) => {
            return new EventStoreReadRepository(logger, dataSource, name);
          },
          inject: [AppLogger, getDataSourceToken(name)],
        },
        {
          provide: EventStoreWriteRepository,
          useFactory: async (logger, context, dataSource, readRepository) => {
            return new EventStoreWriteRepository(logger, context, dataSource, name, readRepository, {
              snapshotInterval,
            });
          },
          inject: [AppLogger, ContextService, getDataSourceToken(name), EventStoreReadRepository],
        },
        {
          provide: EventStoreService,
          useFactory: async (logger: AppLogger, dataSource: DataSource) => {
            return new EventStoreService(logger, dataSource);
          },
          inject: [AppLogger, getDataSourceToken(name)],
        },
      ],
      exports: [EventStoreWriteRepository, EventStoreReadRepository, EventStoreService],
    };
  }
}
