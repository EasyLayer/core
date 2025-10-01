import type { DataSource } from 'typeorm';

/** Create non-negative guards via triggers (SQLite). */
export async function ensureSqliteNonNegTrigger(ds: DataSource, table: string, column: string, allowNull = false) {
  const base = `trg_${table}_${column}_nonneg`;
  const triggers = [`${base}_ins`, `${base}_upd`];

  const rows = (await ds.query(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(() => '?').join(',')})`,
    triggers
  )) as Array<{ name: string }>;

  if (rows.length === triggers.length) {
    return;
  }

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
    if (!rows.find((r) => r.name === `${base}_ins`)) {
      await qr.query(ddlInsert);
    }
    if (!rows.find((r) => r.name === `${base}_upd`)) {
      await qr.query(ddlUpdate);
    }
    await qr.commitTransaction();
  } catch (e) {
    await qr.rollbackTransaction().catch(() => undefined);
    throw e;
  } finally {
    await qr.release();
  }
}
