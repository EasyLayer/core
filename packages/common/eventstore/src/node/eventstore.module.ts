import { Module, DynamicModule, Logger } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider } from '@easylayer/common/cqrs-transport';
import { BaseAdapter, DriverType } from '../core';
import { createSnapshotsEntity, createEventDataEntity, createOutboxEntity, getTableName } from './entities';
import { ensureSchema, ensureNonNegativeGuards, applyDefaultSqlitePragmas } from './node-utils';
import { PostgresAdapter } from './postgres.adapter';
import { SqliteAdapter } from './sqlite.adapter';
import { SqliteFileManager } from './sqlite-file-manager';
import { EventStoreWriteService } from './eventstore-write.service';
import { EventStoreReadService } from './eventstore-read.service';

export const EVENT_STORE_ADAPTER = 'EVENTSTORE_ADAPTER';

export type Driver = 'postgres' | 'sqlite';

/**
 * For SQLite: `database` is a path to a **directory**.
 *   - EventStoreModule manages all .sqlite3 files inside it automatically.
 *   - When snapshots are enabled and an irreversibleHeight is passed to save(),
 *     the active file is rotated on each snapshot at a finalized height.
 *   - When snapshots are disabled, only current.sqlite3 is ever created.
 *
 * For Postgres: `database` is a connection string / database name as before.
 */
type EventStoreConfig = TypeOrmModuleOptions & {
  isGlobal?: boolean;
  type: Driver;
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  transportMaxFrameBytes?: number;
  /** Global prune flag — set once at init. Default: false. */
  allowPruning?: boolean;
};

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    if (typeof window !== 'undefined') {
      throw new Error('Node module cannot be used in browser runtime.');
    }

    const { isGlobal, name, database, aggregates, transportMaxFrameBytes, allowPruning, ...restOptions } = config;

    const ddlDriverForEntities: DriverType = config.type === 'postgres' ? 'postgres' : 'sqlite';
    const snapshotsEntity = createSnapshotsEntity(ddlDriverForEntities);
    const outboxEntity = createOutboxEntity(ddlDriverForEntities);
    const aggregateEntities = aggregates.map((a) => createEventDataEntity(a.aggregateId, ddlDriverForEntities));
    const entities = [outboxEntity, ...aggregateEntities, snapshotsEntity];

    const allTableNames = entities.map(getTableName);
    const outboxTable = getTableName(outboxEntity);
    const aggregateTables = aggregateEntities.map(getTableName);

    // ── SQLite: directory mode ─────────────────────────────────────────────────
    if (config.type === 'sqlite') {
      return {
        module: EventStoreModule,
        global: isGlobal || false,
        imports: [],
        providers: [
          {
            provide: EVENT_STORE_ADAPTER,
            useFactory: async () => {
              const logger = new Logger(EventStoreModule.name);
              logger.log('Initializing SQLite eventstore (directory mode)...', { module: 'eventstore' });

              const fileManager = new SqliteFileManager(database, entities as any, allTableNames, aggregateTables);

              const { dataSource } = await fileManager.initialize();
              logger.log('SQLite eventstore ready.', { module: 'eventstore' });

              const adapter = new SqliteAdapter(dataSource, fileManager);
              await adapter.onModuleInit();
              return adapter;
            },
            inject: [],
          },
          {
            provide: EventStoreWriteService,
            useFactory: (adapter: BaseAdapter, publisher: PublisherProvider, readService: EventStoreReadService) =>
              new EventStoreWriteService(adapter, publisher, readService, { transportMaxFrameBytes, allowPruning }),
            inject: [EVENT_STORE_ADAPTER, PublisherProvider, EventStoreReadService],
          },
          {
            provide: EventStoreReadService,
            useFactory: (adapter: BaseAdapter) => new EventStoreReadService(adapter),
            inject: [EVENT_STORE_ADAPTER],
          },
        ],
        exports: [EventStoreWriteService, EventStoreReadService],
      };
    }

    // ── Postgres: unchanged path ───────────────────────────────────────────────
    const dataSourceOptions: DataSourceOptions = {
      ...restOptions,
      name,
      entities,
      synchronize: false,
      database,
      type: 'postgres',
      extra: { min: 5, max: 20, ...(restOptions as any).extra },
    } as any;

    return {
      module: EventStoreModule,
      global: isGlobal || false,
      imports: [
        TypeOrmModule.forRootAsync({
          imports: [],
          name,
          useFactory: () => ({ ...dataSourceOptions }),
          inject: [],
          dataSourceFactory: async (options?: DataSourceOptions) => {
            const logger = new Logger(EventStoreModule.name);
            if (!options) throw new Error('Invalid DataSource options');
            logger.log('Connecting to database...', { module: 'eventstore' });
            const ds = new DataSource(options);
            await ds.initialize();
            await ensureSchema(ds, allTableNames, logger);
            await ensureNonNegativeGuards(ds, 'postgres', outboxTable, aggregateTables, logger);
            logger.log('Connected and schema ensured.', { module: 'eventstore' });
            return ds;
          },
        }),
      ],
      providers: [
        {
          provide: EVENT_STORE_ADAPTER,
          useFactory: async (dataSource: DataSource) => new PostgresAdapter(dataSource),
          inject: [getDataSourceToken(name)],
        },
        {
          provide: EventStoreWriteService,
          useFactory: (adapter: BaseAdapter, publisher: PublisherProvider, readService: EventStoreReadService) =>
            new EventStoreWriteService(adapter, publisher, readService, { transportMaxFrameBytes, allowPruning }),
          inject: [EVENT_STORE_ADAPTER, PublisherProvider, EventStoreReadService],
        },
        {
          provide: EventStoreReadService,
          useFactory: (adapter: BaseAdapter) => new EventStoreReadService(adapter),
          inject: [EVENT_STORE_ADAPTER],
        },
      ],
      exports: [EventStoreWriteService, EventStoreReadService],
    };
  }
}
