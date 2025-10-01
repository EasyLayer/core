import type { DataSource } from 'typeorm';
import { RdbmsSchemaBuilder } from 'typeorm/schema-builder/RdbmsSchemaBuilder.js';
import type { Logger } from '@nestjs/common';

/** Resolve real table name for an EntitySchema or class. */
export function getTableName(entity: any): string {
  return entity?.options?.tableName || entity?.options?.name || entity?.constructor?.name || String(entity);
}

/**
 * Ensure schema without global synchronize():
 * - If no tables exist → full synchronize() (safe cold start).
 * - If some missing → filter builder log() to apply only CREATE/ALTER for missing tables.
 */
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

  const builder = new RdbmsSchemaBuilder(ds);
  const sql = await builder.log();
  const wanted = new Set(missing.map((x) => x.toLowerCase()));
  const upStatements = sql.upQueries.map((q: any) => (typeof q === 'string' ? q : q.query));

  const filtered = upStatements.filter((q: any) => {
    const ql = q.toLowerCase();
    for (const tbl of wanted) {
      if (
        (ql.includes(` create table `) && ql.includes(` ${tbl} `)) ||
        (ql.includes(` create index `) && ql.includes(` ${tbl}`)) ||
        (ql.includes(` alter table `) && ql.includes(` ${tbl} `)) ||
        ql.includes(`"${tbl}"`) ||
        ql.includes(` ${tbl}(`) ||
        ql.includes(` ${tbl}"`)
      ) {
        return true;
      }
    }
    return false;
  });

  if (filtered.length === 0) {
    log.warn('No CREATE/ALTER statements detected for missing tables. Fallback to synchronize().');
    await ds.synchronize();
    return;
  }

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

  log.log('Partial schema sync completed.');
}
