import { Module, DynamicModule, Provider, Logger } from '@nestjs/common';
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
  ensurePersistentStorage,
  EventStoreReadService,
  EventStoreWriteService,
} from '../core';

import { BrowserSqljsAdapter } from './browser-sqljs.adapter';

export const EVENT_STORE_ADAPTER = 'EVENTSTORE_ADAPTER';
export const BROWSER_DATASOURCE = 'BROWSER_EVENTSTORE_DATASOURCE';

export type Driver = 'sqljs';

type EventStoreConfig = Omit<DataSourceOptions, 'type' | 'entities' | 'synchronize'> & {
  isGlobal?: boolean;
  type: Driver; // Browser: only sqljs
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  sqlJsWasmPath?: string; // optional: override path to sql-wasm.wasm
};

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    if (typeof window === 'undefined') {
      throw new Error(`Browser module cannot be used in Node runtime.`);
    }
    if (config.type !== 'sqljs') {
      throw new Error(`In browser only 'sqljs' driver is supported. Got: '${config.type}'.`);
    }

    const { isGlobal, name, database, aggregates, sqlJsWasmPath, ...restOptions } = config;

    // Entities: outbox + per-aggregate event tables + snapshots.
    const ddlDriverForEntities: DriverType = 'sqlite'; // sql.js uses sqlite-compatible DDL
    const snapshotsEntity = createSnapshotsEntity(ddlDriverForEntities);
    const outboxEntity = createOutboxEntity(ddlDriverForEntities);
    const aggregateEntities = aggregates.map((a) => createEventDataEntity(a.aggregateId, ddlDriverForEntities));
    const entities = [outboxEntity, ...aggregateEntities, snapshotsEntity];

    const allTableNames = entities.map(getTableName);
    const outboxTable = getTableName(outboxEntity);
    const aggregateTables = aggregateEntities.map(getTableName);

    // Pure TypeORM sql.js options (no @nestjs/typeorm)
    const dataSourceOptions: DataSourceOptions = {
      ...(restOptions as any),
      name,
      type: 'sqljs',
      entities,
      synchronize: false,
      useLocalForage: true,
      autoSave: false,
      location: database,
      sqlJsConfig: sqlJsWasmPath ? { locateFile: (file: string) => `${sqlJsWasmPath}/${file}` } : undefined,
    };

    // Provide DataSource via custom provider
    const dataSourceProvider: Provider = {
      provide: BROWSER_DATASOURCE,
      inject: [],
      useFactory: async () => {
        const logger = new Logger(EventStoreModule.name);
        await ensurePersistentStorage(); // request persistent storage grant
        logger.log('Connecting to sql.js database...');
        const ds = new DataSource(dataSourceOptions as DataSourceOptions);
        await ds.initialize();

        await ensureSchema(ds, allTableNames, logger);
        await ensureNonNegativeGuards(ds, 'sqlite', outboxTable, aggregateTables, logger);

        logger.log('Connected and schema ensured.');
        return ds;
      },
    };

    const adapterProvider: Provider = {
      provide: EVENT_STORE_ADAPTER,
      useFactory: async (dataSource: DataSource) => {
        const sqljs = new BrowserSqljsAdapter(dataSource);
        await sqljs.onModuleInit();
        return sqljs;
      },
      inject: [BROWSER_DATASOURCE],
    };

    const serviceProvider: Provider = {
      provide: EventStoreWriteService,
      useFactory: (adapter: BaseAdapter, publisher: PublisherProvider, readService: EventStoreReadService) => {
        return new EventStoreWriteService(adapter, publisher, readService, {});
      },
      inject: [EVENT_STORE_ADAPTER, PublisherProvider, EventStoreReadService],
    };

    const readServiceProvider: Provider = {
      provide: EventStoreReadService,
      useFactory: (adapter: BaseAdapter) => {
        return new EventStoreReadService(adapter);
      },
      inject: [EVENT_STORE_ADAPTER],
    };

    return {
      module: EventStoreModule,
      global: isGlobal || false,
      imports: [],
      providers: [dataSourceProvider, adapterProvider, serviceProvider, readServiceProvider],
      exports: [EventStoreWriteService, EventStoreReadService],
    };
  }
}
