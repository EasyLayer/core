import { Module, DynamicModule, Provider, Logger } from '@nestjs/common';
import type { AggregateRoot } from '@easylayer/common/cqrs';
import { PublisherProvider } from '@easylayer/common/cqrs-transport';
import { getBootstrapLogger } from '@easylayer/common/logger';
import { BaseAdapter } from '../core';
import { EventStoreWriteService } from './eventstore-write.service';
import { BrowserOpfsAdapter } from './browser-opfs.adapter';
import { EventStoreReadService } from './eventstore-read.service';

export const EVENT_STORE_ADAPTER = 'EVENTSTORE_ADAPTER';
export const BROWSER_OPFS_DB = 'BROWSER_OPFS_DB';

/** Keep 'sqljs' as public driver name for backward compat with __ENV config */
export type Driver = 'sqljs';

type EventStoreConfig = {
  isGlobal?: boolean;
  type: Driver;
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  transportMaxFrameBytes?: number;
  sqliteWasmCdnUrl?: string;
};

@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    if (typeof window === 'undefined' && typeof self === 'undefined') {
      throw new Error('Browser module cannot be used in Node runtime.');
    }
    if (config.type !== 'sqljs') {
      throw new Error(`In browser only 'sqljs' driver is supported. Got: '${config.type}'.`);
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

        const cdnUrl =
          config.sqliteWasmCdnUrl ?? 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1/sqlite3.mjs';

        const sqlite3InitModule = (await new Function(`return import("${cdnUrl}")`)()).default;

        const sqlite3 = await sqlite3InitModule({
          print: (s: string) => log.verbose(s),
          printErr: (s: string) => log.warn(s),
        });

        const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
          name: 'easylayer-opfs',
          directory: '/easylayer-db',
          initialCapacity: 6,
        });

        const dbFile = `/${database || name}.sqlite3`;
        const db = new poolUtil.OpfsSAHPoolDb(dbFile);

        db.exec(`PRAGMA journal_mode = DELETE`);
        db.exec(`PRAGMA synchronous  = NORMAL`);
        db.exec(`PRAGMA temp_store   = MEMORY`);
        db.exec(`PRAGMA cache_size   = -65536`);
        db.exec(`PRAGMA foreign_keys = OFF`);

        log.log('OPFS SQLite database ready.', { module: 'eventstore' } as any);
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

    const serviceProvider: Provider = {
      provide: EventStoreWriteService,
      useFactory: (adapter: BaseAdapter, publisher: PublisherProvider, readService: EventStoreReadService) =>
        new EventStoreWriteService(adapter, publisher, readService, { transportMaxFrameBytes }),
      inject: [EVENT_STORE_ADAPTER, PublisherProvider, EventStoreReadService],
    };

    const readServiceProvider: Provider = {
      provide: EventStoreReadService,
      useFactory: (adapter: BaseAdapter) => new EventStoreReadService(adapter),
      inject: [EVENT_STORE_ADAPTER],
    };

    return {
      module: EventStoreModule,
      global: isGlobal || false,
      imports: [],
      providers: [dbProvider, adapterProvider, serviceProvider, readServiceProvider],
      exports: [EventStoreWriteService, EventStoreReadService],
    };
  }
}
