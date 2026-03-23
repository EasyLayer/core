import { Module, DynamicModule, Provider, Logger } from '@nestjs/common';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider } from '@easylayer/common/cqrs-transport';
import { getBootstrapLogger } from '@easylayer/common/logger';
import { BaseAdapter } from '../core';
import { EventStoreWriteService } from './eventstore-write.service';
import { BrowserOpfsAdapter } from './browser-opfs.adapter';
import { EventStoreReadService } from './eventstore-read.service';
import type { DriverType } from '../core';

export const EVENT_STORE_ADAPTER = 'EVENTSTORE_ADAPTER';
export const BROWSER_OPFS_DB = 'BROWSER_OPFS_DB';

type EventStoreConfig = {
  isGlobal?: boolean;
  type: DriverType;
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  transportMaxFrameBytes?: number;
  sqliteRuntimeBaseUrl: string;
};

type SqliteInitModule = () => Promise<any>;

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    if (typeof window === 'undefined' && typeof self === 'undefined') {
      throw new Error('Browser module cannot be used in Node runtime.');
    }

    if (config.type !== 'sqlite-opfs') {
      throw new Error(`In browser only 'sqlite-opfs' driver is supported. Got: '${config.type}'.`);
    }

    if (!config.sqliteRuntimeBaseUrl) {
      throw new Error('sqliteRuntimeBaseUrl is required in browser sqlite-opfs mode.');
    }

    const logger = getBootstrapLogger(EventStoreModule.name);
    logger.trace('Starting eventstore module registration', { module: 'bootstrap' });

    const { isGlobal, name, database, aggregates, transportMaxFrameBytes } = config;
    const aggregateIds = aggregates.map((a) => (a as any).aggregateId as string).filter(Boolean);

    const dbProvider: Provider = {
      provide: BROWSER_OPFS_DB,
      inject: [],
      useFactory: async () => {
        const log = new Logger(EventStoreModule.name);
        log.log('Opening OPFS SQLite database...', { module: 'eventstore' } as any);

        const runtimeBaseUrl = config.sqliteRuntimeBaseUrl.replace(/\/+$/, '');
        const sqliteModuleUrl = `${runtimeBaseUrl}/index.mjs`;

        log.log('Loading sqlite-wasm runtime...', {
          module: 'eventstore',
          args: { sqliteModuleUrl },
        } as any);

        const imported = await import(/* @vite-ignore */ sqliteModuleUrl);
        const sqlite3InitModule = imported.default as SqliteInitModule;

        if (typeof sqlite3InitModule !== 'function') {
          throw new Error(`Invalid sqlite runtime module loaded from '${sqliteModuleUrl}'.`);
        }

        const sqlite3 = await sqlite3InitModule();

        const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
          name: 'eventstore',
          directory: '/eventstore',
          initialCapacity: 6,
        });

        const dbFile = `/${database || 'bitcoin.sqlite3'}`;
        const db = new poolUtil.OpfsSAHPoolDb(dbFile);

        db.exec(`PRAGMA journal_mode = DELETE`);
        db.exec(`PRAGMA synchronous = NORMAL`);
        db.exec(`PRAGMA temp_store = MEMORY`);
        db.exec(`PRAGMA cache_size = -65536`);
        db.exec(`PRAGMA foreign_keys = OFF`);

        log.log('OPFS SQLite database ready.', {
          module: 'eventstore',
          args: { dbFile, runtimeBaseUrl },
        } as any);

        return db;
      },
    };

    const adapterProvider: Provider = {
      provide: EVENT_STORE_ADAPTER,
      inject: [BROWSER_OPFS_DB],
      useFactory: async (db: any) => {
        const adapter = new BrowserOpfsAdapter();
        await adapter.init(db, aggregateIds);
        return adapter;
      },
    };

    const readServiceProvider: Provider = {
      provide: EventStoreReadService,
      inject: [EVENT_STORE_ADAPTER],
      useFactory: (adapter: BaseAdapter) => new EventStoreReadService(adapter),
    };

    const serviceProvider: Provider = {
      provide: EventStoreWriteService,
      inject: [EVENT_STORE_ADAPTER, PublisherProvider, EventStoreReadService],
      useFactory: (adapter: BaseAdapter, publisher: PublisherProvider, readService: EventStoreReadService) =>
        new EventStoreWriteService(adapter, publisher, readService, { transportMaxFrameBytes }),
    };

    return {
      module: EventStoreModule,
      global: isGlobal || false,
      imports: [],
      providers: [dbProvider, adapterProvider, readServiceProvider, serviceProvider],
      exports: [EventStoreWriteService, EventStoreReadService],
    };
  }
}
