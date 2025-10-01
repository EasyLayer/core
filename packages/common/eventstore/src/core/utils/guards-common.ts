import type { DataSource } from 'typeorm';
import type { Logger } from '@nestjs/common';
import { ensurePgCheck } from './guards-pg';
import { ensureSqliteNonNegTrigger } from './guards-sqlite';

export type DriverType = 'postgres' | 'sqlite' | 'sqljs';

/** Ensure non-negative guards for outbox.eventVersion/blockHeight and aggregate.version. */
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
