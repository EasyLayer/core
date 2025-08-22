import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { addTransactionalDataSource, initializeTransactionalContext } from 'typeorm-transactional';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import { RdbmsSchemaBuilder } from 'typeorm/schema-builder/RdbmsSchemaBuilder.js';

import { LoggerModule, AppLogger } from '@easylayer/common/logger';
import { AggregateRoot } from '@easylayer/common/cqrs';
import { Publisher } from '@easylayer/common/cqrs-transport';
import { ContextModule } from '@easylayer/common/context';

import { createSnapshotsEntity } from './snapshots.model';
import { createEventDataEntity } from './event-data.model';
import { createOutboxEntity } from './outbox.model';

import { EventStoreService } from './eventstore.service';
import { BaseAdapter } from './adapters/base-adapter';
import { PostgresAdapter } from './adapters/postgres.adapter';
import { SqliteEventStoreAdapter } from './adapters/sqlite.adapter';

/** Runtime config for EventStoreModule */
type EventStoreConfig = TypeOrmModuleOptions & {
  type: 'sqlite' | 'postgres';
  name: string;
  database: string;
  aggregates: AggregateRoot[];
  snapshotInterval?: number;
  sqliteBatchSize?: number;
};

/** Internal helper: resolve table name for a TypeORM EntitySchema */
function getTableName(entity: any): string {
  // Prefer explicit tableName, otherwise fallback to name
  return entity?.options?.tableName || entity?.options?.name || entity?.constructor?.name || String(entity);
}

/**
 * Ensures schema exists without blindly enabling global synchronize().
 *
 * Strategy:
 * - If none of the required tables exist → run full synchronize() (cold start).
 * - If some tables exist and some are missing → use RdbmsSchemaBuilder.log()
 *   to get upQueries and execute only those touching missing tables (CREATE TABLE/INDEX/ALTER ...).
 * - If queries cannot be matched (driver hides names), fallback to synchronize() as a last resort.
 */
async function ensureSchema(ds: DataSource, allTableNames: string[], log: AppLogger) {
  // Probe which tables are present
  const qr = ds.createQueryRunner();
  await qr.connect();
  const existing: string[] = [];
  const missing: string[] = [];

  for (const t of allTableNames) {
    const has = await qr.hasTable(t);
    (has ? existing : missing).push(t);
  }
  await qr.release();

  // Nothing to do
  if (missing.length === 0) {
    log.info('Schema is complete. No sync required.');
    return;
  }

  // Cold start: nothing exists → safe to run full synchronize()
  if (existing.length === 0) {
    log.info('Cold start detected. Running full synchronize().');
    await ds.synchronize();
    return;
  }

  // Partial: some tables missing
  log.info(`Partial schema sync. Missing: ${missing.join(', ')}`);

  // Use internal RdbmsSchemaBuilder to get SQL for synchronize() and filter only relevant queries
  const builder = new RdbmsSchemaBuilder(ds);
  const sql = await builder.log(); // SqlInMemory

  const wanted = new Set(missing.map((x) => x.toLowerCase()));
  const upStatements = sql.upQueries.map((q: any) => (typeof q === 'string' ? q : q.query));

  // Filter only statements that mention missing table names
  const filtered = upStatements.filter((q: any) => {
    const ql = q.toLowerCase();
    // Accept explicit DDL touching the missing tables
    for (const tbl of wanted) {
      // Strict but pragmatic heuristics
      if (
        (ql.includes(` create table `) && ql.includes(` ${tbl} `)) ||
        (ql.includes(` create index `) && ql.includes(` ${tbl}`)) ||
        (ql.includes(` alter table `) && ql.includes(` ${tbl} `))
      ) {
        return true;
      }
      // Also allow quoted or schema-qualified mentions: "schema"."table", "table"
      if (ql.includes(`"${tbl}"`) || ql.includes(` ${tbl}(`) || ql.includes(` ${tbl}"`)) {
        // Keep it, most likely related
        return true;
      }
    }
    return false;
  });

  // If nothing matched, fallback to synchronize() (best effort)
  if (filtered.length === 0) {
    log.warn('No CREATE/ALTER statements detected for missing tables. Fallback to synchronize().');
    await ds.synchronize();
    return;
  }

  // Execute only relevant DDL in a single transaction
  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    for (const stmt of filtered) {
      await runner.query(stmt);
    }
    await runner.commitTransaction();
  } catch (err) {
    await runner.rollbackTransaction().catch(() => undefined);
    throw err;
  } finally {
    await runner.release();
  }

  log.info('Partial schema sync completed.');
}

/**
 * EventStoreModule
 * - Builds TypeORM DataSource with all entities (outbox, per-aggregate tables, snapshots).
 * - Ensures schema with partial sync if needed (safe for existing data).
 * - Registers adapter (Postgres/SQLite) and EventStoreService.
 */
@Module({})
export class EventStoreModule {
  static async forRootAsync(config: EventStoreConfig): Promise<DynamicModule> {
    const { name, database, aggregates, ...restOptions } = config;

    // Initialize transactional context for typeorm-transactional
    initializeTransactionalContext();

    // Compose entity list: outbox + aggregate tables + snapshots
    const snapshotsEntity = createSnapshotsEntity(config.type);
    const outboxEntity = createOutboxEntity(config.type);
    const aggregateEntities = aggregates.map((agg) => createEventDataEntity(agg.aggregateId, config.type));
    const entities = [outboxEntity, ...aggregateEntities, snapshotsEntity];

    // We always pass synchronize:false; schema will be ensured manually
    const dataSourceOptions: DataSourceOptions & { log?: AppLogger } = {
      ...(config.type === 'postgres' ? { extra: { min: 5, max: 20 } } : {}),
      ...restOptions,
      name,
      entities,
      synchronize: false,
      database,
    } as any;

    // Precompute target table names (for partial sync and diagnostics)
    const allTableNames = entities.map(getTableName);

    return {
      module: EventStoreModule,
      imports: [
        ContextModule,
        LoggerModule.forRoot({ componentName: EventStoreModule.name }),

        // Build the dedicated DataSource for Event Store
        TypeOrmModule.forRootAsync({
          imports: [LoggerModule.forRoot({ componentName: EventStoreModule.name })],
          name,
          useFactory: (log: AppLogger) => ({ ...dataSourceOptions, log }),
          inject: [AppLogger],

          dataSourceFactory: async (options?: DataSourceOptions & { log?: AppLogger }) => {
            if (!options) throw new Error('Invalid DataSource options');

            options.log?.info('Connecting to database...');
            const ds = new DataSource(options);
            await ds.initialize();

            // Ensure schema: create only missing tables/indexes/constraints
            await ensureSchema(ds, allTableNames, options.log!);

            // Register transactional DataSource with the given unique name
            addTransactionalDataSource({ name, dataSource: ds });

            options.log?.info('Connected and schema ensured.');
            return ds;
          },
        }),
      ],
      providers: [
        {
          provide: 'EVENTSTORE_ADAPTER',
          useFactory: (log: AppLogger, dataSource: DataSource) => {
            return config.type === 'postgres'
              ? new PostgresAdapter(log, dataSource)
              : new SqliteEventStoreAdapter(log, dataSource);
          },
          inject: [AppLogger, getDataSourceToken(name)],
        },
        {
          provide: EventStoreService,
          useFactory: (log: AppLogger, adapter: BaseAdapter, publisher: Publisher) => {
            return new EventStoreService(log, adapter, publisher);
          },
          inject: [AppLogger, 'EVENTSTORE_ADAPTER', Publisher],
        },
      ],
      exports: [EventStoreService, 'EVENTSTORE_ADAPTER'],
    };
  }
}
