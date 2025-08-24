import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule, getDataSourceToken, TypeOrmModuleOptions } from '@nestjs/typeorm';
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
import { DriverType, BaseAdapter, PostgresAdapter, SqliteEventStoreAdapter, BrowserSqljsAdapter } from './adapters';

/** Runtime config for EventStoreModule */
type EventStoreConfig = TypeOrmModuleOptions & {
  type: DriverType;
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

async function ensureNonNegativeGuards(
  ds: DataSource,
  driver: DriverType,
  outboxTable: string,
  aggregateTables: string[],
  log: AppLogger
) {
  if (driver === 'postgres') {
    await ensurePgCheck(
      ds,
      outboxTable,
      'chk_outbox_blockheight_nonneg',
      `"blockHeight" IS NULL OR "blockHeight" >= 0`
    );
    await ensurePgCheck(ds, outboxTable, 'chk_outbox_eventversion_nonneg', `"eventVersion" >= 0`);
    for (const t of aggregateTables) {
      await ensurePgCheck(ds, t, `chk_${t}_version_nonneg`, `"version" >= 0`);
    }
    log.info('PG CHECK constraints ensured (non-negative guards).');
  } else {
    // SQLite: add BEFORE INSERT/UPDATE triggers that abort on negative values (safe for existing tables)
    await ensureSqliteNonNegTrigger(ds, outboxTable, 'blockHeight', /*allowNull*/ true);
    await ensureSqliteNonNegTrigger(ds, outboxTable, 'eventVersion');
    for (const t of aggregateTables) {
      await ensureSqliteNonNegTrigger(ds, t, 'version');
    }
    log.info('SQLite triggers ensured (non-negative guards).');
  }
}

async function ensurePgCheck(ds: DataSource, table: string, constraint: string, expr: string) {
  const existsSql = `
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = $1 AND c.conname = $2
    LIMIT 1
  `;
  const [{ exists } = { exists: 0 }] = (await ds.query(`SELECT EXISTS(${existsSql}) AS exists`, [
    table,
    constraint,
  ])) as any[];

  if (!exists) {
    await ds.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK (${expr})`);
  }
}

async function ensureSqliteNonNegTrigger(ds: DataSource, table: string, column: string, allowNull = false) {
  const base = `trg_${table}_${column}_nonneg`;
  const triggers = [`${base}_ins`, `${base}_upd`];

  // check both
  const rows = (await ds.query(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(() => '?').join(',')})`,
    triggers
  )) as Array<{ name: string }>;

  if (rows.length === triggers.length) return; // already created

  const cond = allowNull ? `NEW."${column}" IS NOT NULL AND NEW."${column}" < 0` : `NEW."${column}" < 0`;

  const ddlInsert = `
    CREATE TRIGGER "${base}_ins"
    BEFORE INSERT ON "${table}"
    WHEN ${cond}
    BEGIN
      SELECT RAISE(ABORT, 'Constraint ${base}: ${column} must be >= 0 (NULL allowed=${allowNull})');
    END;
  `;

  const ddlUpdate = `
    CREATE TRIGGER "${base}_upd"
    BEFORE UPDATE ON "${table}"
    WHEN ${cond}
    BEGIN
      SELECT RAISE(ABORT, 'Constraint ${base}: ${column} must be >= 0 (NULL allowed=${allowNull})');
    END;
  `;

  const qr = ds.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    if (!rows.find((r) => r.name === `${base}_ins`)) await qr.query(ddlInsert);
    if (!rows.find((r) => r.name === `${base}_upd`)) await qr.query(ddlUpdate);
    await qr.commitTransaction();
  } catch (e) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await qr.release();
  }
}

/* eslint-disable no-empty */
export async function ensurePersistentStorage() {
  if (typeof window === 'undefined') return;
  const anyNav: any = navigator as any;
  if (!anyNav.storage || typeof anyNav.storage.persist !== 'function') return;
  try {
    const already = await anyNav.storage.persisted?.();
    if (!already) await anyNav.storage.persist();
  } catch {}
}
/* eslint-enable no-empty */

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

    // Compose entity list: outbox + aggregate tables + snapshots
    const ddlDriverForEntities = config.type === 'postgres' ? 'postgres' : 'sqlite';
    const snapshotsEntity = createSnapshotsEntity(ddlDriverForEntities);
    const outboxEntity = createOutboxEntity(ddlDriverForEntities);
    const aggregateEntities = aggregates.map((a) => createEventDataEntity(a.aggregateId, ddlDriverForEntities));
    const entities = [outboxEntity, ...aggregateEntities, snapshotsEntity];

    // We always pass synchronize:false; schema will be ensured manually
    const dataSourceOptions: DataSourceOptions & { log?: AppLogger } = {
      ...restOptions,
      name,
      entities,
      synchronize: false,
      database,
      ...(config.type === 'postgres'
        ? { type: 'postgres', extra: { min: 5, max: 20 } }
        : config.type === 'sqlite'
          ? { type: 'sqlite' as const }
          : {
              type: 'sqljs' as const,
              // Load/read via localforage, BUT turn off autosave — flash yourself after each COMMIT
              useLocalForage: true,
              autoSave: false,
              // autoSaveInterval: 3000,
              // TypeORM will automatically insert the prefix when loading,
              // but for our entry we use the same key
              location: database,
            }),
    } as any;

    // Precompute target table names (for partial sync and diagnostics)
    const allTableNames = entities.map(getTableName);
    const outboxTable = getTableName(outboxEntity);
    const aggregateTables = aggregateEntities.map(getTableName);

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

            // SQLJS: Browser only + sqljs: request persistent storage BEFORE initialization
            if (typeof window !== 'undefined' && config.type === 'sqljs') {
              await ensurePersistentStorage();
            }

            options.log?.info('Connecting to database...');
            const ds = new DataSource(options);
            await ds.initialize();

            // Ensure schema: create only missing tables/indexes/constraints
            await ensureSchema(ds, allTableNames, options.log!);
            await ensureNonNegativeGuards(ds, config.type, outboxTable, aggregateTables, options.log!);

            options.log?.info('Connected and schema ensured.');
            return ds;
          },
        }),
      ],
      providers: [
        {
          provide: 'EVENTSTORE_ADAPTER',
          useFactory: (log: AppLogger, dataSource: DataSource) => {
            if (config.type === 'postgres') return new PostgresAdapter(log, dataSource);
            if (config.type === 'sqlite') return new SqliteEventStoreAdapter(log, dataSource);
            if (config.type === 'sqljs') return new BrowserSqljsAdapter(log, dataSource);
            throw new Error('Unknown eventstore adapter');
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
