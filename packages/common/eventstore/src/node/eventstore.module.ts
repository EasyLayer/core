import { Module, DynamicModule, Logger } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider } from '@easylayer/common/cqrs-transport';
import {
  createSnapshotsEntity,
  createEventDataEntity,
  createOutboxEntity,
  BaseAdapter,
  ensureSchema,
  getTableName,
  ensureNonNegativeGuards,
  DriverType,
  EventStoreReadService,
  EventStoreWriteService,
} from '../core';
import { PostgresAdapter } from './postgres.adapter';
import { SqliteAdapter } from './sqlite.adapter';

export const EVENT_STORE_ADAPTER = 'EVENTSTORE_ADAPTER';

export type Driver = 'postgres' | 'sqlite';

type EventStoreConfig = TypeOrmModuleOptions & {
  isGlobal?: boolean;
  type: Driver; // Node: sqlite or postgres
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  /**
   * Hard cap per transport frame in bytes.
   * Must match transport-sdk maxWireBytes and SDK client settings.
   * Default: 10 MB (Bitcoin block events can reach 2–4 MB serialized).
   */
  transportMaxFrameBytes?: number;
};

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    if (typeof window !== 'undefined') {
      throw new Error(`Node module cannot be used in browser runtime.`);
    }

    const { isGlobal, name, database, aggregates, transportMaxFrameBytes, ...restOptions } = config;

    // Entities: outbox + per-aggregate event tables + snapshots.
    const ddlDriverForEntities: DriverType = config.type === 'postgres' ? 'postgres' : 'sqlite';
    const snapshotsEntity = createSnapshotsEntity(ddlDriverForEntities);
    const outboxEntity = createOutboxEntity(ddlDriverForEntities);
    const aggregateEntities = aggregates.map((a) => createEventDataEntity(a.aggregateId, ddlDriverForEntities));
    const entities = [outboxEntity, ...aggregateEntities, snapshotsEntity];

    // Always pass synchronize:false; we ensure schema manually.
    const dataSourceOptions: DataSourceOptions = {
      ...restOptions,
      name,
      entities,
      synchronize: false,
      database,
      // merge extra pool settings — user config wins for any keys they provide.
      ...(config.type === 'postgres'
        ? { type: 'postgres', extra: { min: 5, max: 20, ...(restOptions as any).extra } }
        : { type: 'sqlite' as const }),
    } as any;

    const allTableNames = entities.map(getTableName);
    const outboxTable = getTableName(outboxEntity);
    const aggregateTables = aggregateEntities.map(getTableName);

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

            if (!options) {
              throw new Error('Invalid DataSource options');
            }

            logger.log('Connecting to database...', {
              module: 'eventstore',
            });
            const ds = new DataSource(options);
            await ds.initialize();

            await ensureSchema(ds, allTableNames, logger);
            await ensureNonNegativeGuards(ds, ddlDriverForEntities, outboxTable, aggregateTables, logger);

            logger.log('Connected and schema ensured.', {
              module: 'eventstore',
            });
            return ds;
          },
        }),
      ],
      providers: [
        {
          provide: EVENT_STORE_ADAPTER,
          useFactory: async (dataSource: DataSource) => {
            if (config.type === 'postgres') {
              return new PostgresAdapter(dataSource);
            }
            if (config.type === 'sqlite') {
              const sqlite = new SqliteAdapter(dataSource);
              await sqlite.onModuleInit();
              return sqlite;
            }
            throw new Error('Unknown eventstore adapter');
          },
          inject: [getDataSourceToken(name)],
        },
        {
          provide: EventStoreWriteService,
          useFactory: (adapter: BaseAdapter, publisher: PublisherProvider, readService: EventStoreReadService) => {
            return new EventStoreWriteService(adapter, publisher, readService, {
              transportMaxFrameBytes,
            });
          },
          inject: [EVENT_STORE_ADAPTER, PublisherProvider, EventStoreReadService],
        },
        {
          provide: EventStoreReadService,
          useFactory: (adapter: BaseAdapter) => {
            return new EventStoreReadService(adapter);
          },
          inject: [EVENT_STORE_ADAPTER],
        },
      ],
      exports: [EventStoreWriteService, EventStoreReadService],
    };
  }
}
