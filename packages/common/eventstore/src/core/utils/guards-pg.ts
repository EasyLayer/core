import type { DataSource } from 'typeorm';

/** Ensure a named CHECK constraint exists on a table (Postgres). */
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
