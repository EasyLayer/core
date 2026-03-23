/**
 * Node-only utilities that depend on TypeORM DataSource.
 * Never import from browser code.
 */
import type { DataSource } from 'typeorm';
import type { Logger } from '@nestjs/common';
import type { DriverType } from '../core';

export async function ensurePgCheck(ds: DataSource, table: string, constraint: string, expr: string) {
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

export async function ensureSqliteNonNegTrigger(ds: DataSource, table: string, column: string, allowNull = false) {
  const base = `trg_${table}_${column}_nonneg`;
  const triggers = [`${base}_ins`, `${base}_upd`];

  const rows = (await ds.query(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(() => '?').join(',')})`,
    triggers
  )) as Array<{ name: string }>;

  if (rows.length === triggers.length) return;

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

export async function ensureNonNegativeGuards(
  ds: DataSource,
  driver: DriverType,
  outboxTable: string,
  aggregateTables: string[],
  log: Logger
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
    log.log('PG CHECK constraints ensured (non-negative guards).');
  } else {
    await ensureSqliteNonNegTrigger(ds, outboxTable, 'blockHeight', true);
    await ensureSqliteNonNegTrigger(ds, outboxTable, 'eventVersion');
    for (const t of aggregateTables) {
      await ensureSqliteNonNegTrigger(ds, t, 'version');
    }
    log.log('SQLite triggers ensured (non-negative guards).');
  }
}

export async function ensureSchema(ds: DataSource, allTableNames: string[], log: Logger) {
  const qr = ds.createQueryRunner();
  await qr.connect();
  const existing: string[] = [];
  const missing: string[] = [];

  for (const t of allTableNames) {
    const has = await qr.hasTable(t);
    if (has) existing.push(t);
    else missing.push(t);
  }
  await qr.release();

  if (missing.length === 0) {
    log.log('Schema is complete. No sync required.');
    return;
  }
  if (existing.length === 0) {
    log.log('Cold start detected. Running full synchronize().');
    await ds.synchronize();
    return;
  }

  log.log(`Partial schema sync. Missing: ${missing.join(', ')}`);

  let RdbmsSchemaBuilder: any;
  try {
    const mod = await import('typeorm/schema-builder/RdbmsSchemaBuilder.js');
    RdbmsSchemaBuilder = mod.RdbmsSchemaBuilder;
  } catch {
    log.warn('RdbmsSchemaBuilder not available, falling back to synchronize().');
    await ds.synchronize();
    return;
  }

  const builder = new RdbmsSchemaBuilder(ds);
  const sql = await builder.log();
  const wanted = new Set(missing.map((x) => x.toLowerCase()));
  const upStmts = sql.upQueries.map((q: any) => (typeof q === 'string' ? q : q.query));

  const filtered = upStmts.filter((q: any) => {
    const ql = q.toLowerCase();
    for (const tbl of wanted) {
      if (
        (ql.includes(' create table ') && ql.includes(` ${tbl} `)) ||
        (ql.includes(' create index ') && ql.includes(` ${tbl}`)) ||
        (ql.includes(' alter table ') && ql.includes(` ${tbl} `)) ||
        ql.includes(`"${tbl}"`) ||
        ql.includes(` ${tbl}(`) ||
        ql.includes(` ${tbl}"`)
      )
        return true;
    }
    return false;
  });

  if (filtered.length === 0) {
    log.warn('No CREATE/ALTER statements detected. Fallback to synchronize().');
    await ds.synchronize();
    return;
  }

  const runner = ds.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    for (const stmt of filtered) await runner.query(stmt);
    await runner.commitTransaction();
  } catch (err) {
    await runner.rollbackTransaction().catch(() => undefined);
    throw err;
  } finally {
    await runner.release();
  }

  log.log('Partial schema sync completed.');
}
