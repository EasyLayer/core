/**
 * SqliteFileManager — manages a directory of SQLite files for the rotation mode.
 *
 * Layout:
 *   {directory}/
 *     current.sqlite3              ← active write file (always present)
 *     0-10000.sqlite3              ← archived: fromHeight=0, snapshotHeight=10000
 *     10001-25000.sqlite3          ← archived: fromHeight=10001, snapshotHeight=25000
 *     ...
 *
 * Archived files are write-once: once sealed, they are never read by the adapter.
 * All reads always go to current.sqlite3 only. If allowPruning=true, archived files
 * are deleted according to the retention policy — the user explicitly accepts that
 * historical data below the pruning boundary is gone.
 *
 * Three constraints that shape the rotation implementation:
 *
 * [P1] EXCLUSIVE LOCK — TypeORM holds PRAGMA locking_mode=EXCLUSIVE on current.sqlite3.
 *   Opening a second connection to the same file (e.g. via better-sqlite3) will fail
 *   with SQLITE_BUSY/SQLITE_LOCKED. All ATTACH + copy queries during rotation are
 *   therefore executed through the EXISTING TypeORM DataSource.
 *
 * [P2] WAL FILES — WAL mode creates current.sqlite3-wal and current.sqlite3-shm.
 *   fs.renameSync only moves the main file; WAL files become orphaned if rename
 *   happens before the DataSource is closed. Correct order: destroy() the TypeORM
 *   DataSource first (triggers WAL checkpoint and removes -wal/-shm), then rename.
 *
 * [P3] WATERMARK — lastSeenId in SqliteAdapter must NOT be reset after rotation.
 *   Outbox rows are copied with their original ids; the watermark is valid for the
 *   new file just as it was for the old one. Resetting it would cause duplicate delivery.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import type { EntitySchema } from 'typeorm';
import { ensureSchema, ensureNonNegativeGuards, applyDefaultSqlitePragmas } from './node-utils';

const ARCHIVED_FILE_RE = /^(\d+)-(\d+)\.sqlite3$/;

interface ArchivedFileEntry {
  filePath: string;
  fromHeight: number;
  snapshotHeight: number;
}

export class SqliteFileManager {
  private _archivedFiles: ArchivedFileEntry[] = [];
  private _currentFromHeight: number = 0;

  constructor(
    private readonly directory: string,
    private readonly entities: EntitySchema[],
    private readonly allTableNames: string[],
    private readonly aggregateTableNames: string[]
  ) {}

  get currentFilePath(): string {
    return path.join(this.directory, 'current.sqlite3');
  }

  get currentFromHeight(): number {
    return this._currentFromHeight;
  }

  // ─────────────────────────────── INITIALIZATION ───────────────────────────────

  /**
   * Must be called once before any other method.
   * 1. Creates the directory if missing.
   * 2. Recovers from a partially completed rotation (new.sqlite3 present).
   * 3. Scans for archived files to derive currentFromHeight (files themselves are never read).
   * 4. Creates current.sqlite3 if it does not exist (cold start).
   * 5. Returns an initialized TypeORM DataSource for current.sqlite3.
   */
  async initialize(): Promise<{ dataSource: DataSource }> {
    fs.mkdirSync(this.directory, { recursive: true });

    this._recoverIfNeeded();

    // Scan archived files only to determine currentFromHeight.
    // They are never opened for reading by the adapter.
    const entries = fs.readdirSync(this.directory);
    this._archivedFiles = [];
    for (const name of entries) {
      const m = ARCHIVED_FILE_RE.exec(name);
      if (!m) continue;
      this._archivedFiles.push({
        filePath: path.join(this.directory, name),
        fromHeight: parseInt(m[1]!, 10),
        snapshotHeight: parseInt(m[2]!, 10),
      });
    }
    this._archivedFiles.sort((a, b) => a.fromHeight - b.fromHeight);

    if (this._archivedFiles.length > 0) {
      const last = this._archivedFiles[this._archivedFiles.length - 1]!;
      this._currentFromHeight = last.snapshotHeight + 1;
    } else {
      this._currentFromHeight = 0;
    }

    const dataSource = await this._createAndInitDataSource(this.currentFilePath);
    return { dataSource };
  }

  /**
   * Handles a partially completed rotation detected by the presence of new.sqlite3.
   *
   * Possible states:
   *   A) new.sqlite3 + current.sqlite3 both exist
   *      → crash before step "rename current→archived" (copy was done, nothing renamed yet)
   *      → new.sqlite3 holds data already present in current.sqlite3 → safe to delete new.sqlite3
   *
   *   B) new.sqlite3 exists, current.sqlite3 does NOT exist
   *      → crash after "rename current→archived" but before "rename new→current"
   *      → new.sqlite3 is the correct active file → rename it to current.sqlite3
   */
  private _recoverIfNeeded(): void {
    const newPath = path.join(this.directory, 'new.sqlite3');
    if (!fs.existsSync(newPath)) return;

    const currentExists = fs.existsSync(this.currentFilePath);
    if (currentExists) {
      fs.unlinkSync(newPath);
    } else {
      fs.renameSync(newPath, this.currentFilePath);
    }
  }

  // ─────────────────────────────── ROTATION ───────────────────────────────

  /**
   * Performs file rotation triggered by a snapshot at snapshotBlockHeight.
   * Called from SqliteAdapter.createSnapshot() inside writeLock.
   *
   * Returns the new DataSource for current.sqlite3.
   * Does NOT modify lastSeenId — see [P3] above.
   *
   * Operation order (respects [P1], [P2]):
   *  1. Create schema for new.sqlite3 via a short-lived TypeORM DS (different file — no lock conflict).
   *  2. ATTACH new.sqlite3 and copy tail data through the EXISTING TypeORM DataSource [P1].
   *  3. DETACH new.sqlite3.
   *  4. destroy() the existing DataSource — WAL checkpoint + lock release [P2].
   *  5. fs.renameSync(current → archived)  — safe: WAL already flushed.
   *  6. fs.renameSync(new → current).
   *  7. Update archivedFiles index and currentFromHeight.
   *  8. Create and return a new TypeORM DataSource for current.sqlite3.
   */
  async rotate(currentDataSource: DataSource, snapshotBlockHeight: number): Promise<{ newDataSource: DataSource }> {
    const currentPath = this.currentFilePath;
    const newTempPath = path.join(this.directory, 'new.sqlite3');
    const archivedPath = path.join(this.directory, `${this._currentFromHeight}-${snapshotBlockHeight}.sqlite3`);

    // Step 1: Initialize schema for new.sqlite3 via a separate short-lived DS.
    // Opening a different file has no lock conflict with current.sqlite3 [P1].
    const tempDs = await this._createAndInitDataSource(newTempPath);
    await tempDs.destroy();

    // Step 2: ATTACH + copy through the EXISTING TypeORM DataSource [P1].
    const qr = currentDataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`ATTACH DATABASE ? AS new_db`, [newTempPath]);
      await qr.startTransaction();
      try {
        // 2a. Tail events for each aggregate table (blockHeight > snapshotBlockHeight).
        for (const table of this.aggregateTableNames) {
          await qr.query(
            `INSERT OR IGNORE INTO new_db."${table}"
             SELECT * FROM "${table}"
             WHERE "blockHeight" IS NOT NULL AND "blockHeight" > ?`,
            [snapshotBlockHeight]
          );
        }

        // 2b. All outbox rows (needed for continued delivery from the new file).
        await qr.query(`INSERT OR IGNORE INTO new_db."outbox" SELECT * FROM "outbox"`);

        // 2c. Latest snapshot per aggregateId (needed for restoreExactStateLatest on startup).
        await qr.query(`
          INSERT OR IGNORE INTO new_db."snapshots"
          SELECT s.*
          FROM "snapshots" s
          INNER JOIN (
            SELECT "aggregateId", MAX("blockHeight") AS maxBH
            FROM "snapshots"
            GROUP BY "aggregateId"
          ) latest
            ON s."aggregateId" = latest."aggregateId"
           AND s."blockHeight" = latest.maxBH
        `);

        await qr.commitTransaction();
      } catch (e) {
        await qr.rollbackTransaction().catch(() => undefined);
        throw e;
      }

      // Step 3: DETACH before closing the DataSource.
      await qr.query(`DETACH DATABASE new_db`);
    } finally {
      await qr.release();
    }

    // Step 4: destroy() BEFORE rename [P2].
    // Closing the connection triggers WAL checkpoint: all WAL pages are flushed
    // into the main file and current.sqlite3-wal / current.sqlite3-shm are removed.
    // After this, current.sqlite3 is a complete self-contained file safe to rename.
    await currentDataSource.destroy();

    // Step 5–6: Atomic renames (OS-atomic on the same filesystem).
    fs.renameSync(currentPath, archivedPath);
    fs.renameSync(newTempPath, currentPath);

    // Step 7: Update in-memory index.
    this._archivedFiles.push({
      filePath: archivedPath,
      fromHeight: this._currentFromHeight,
      snapshotHeight: snapshotBlockHeight,
    });
    this._currentFromHeight = snapshotBlockHeight + 1;

    // Step 8: Create and initialize the new active DataSource.
    const newDataSource = await this._createAndInitDataSource(currentPath);
    return { newDataSource };
  }

  // ─────────────────────────────── PRUNING ───────────────────────────────

  /**
   * Deletes archived files according to the retention policy (called when allowPruning=true).
   *
   * Rules (mirror the snapshot pruning logic from SqliteAdapter.pruneOldSnapshots):
   *  - Always keep at least minKeep of the most recent archived files.
   *  - Keep any file whose snapshotHeight >= (currentSnapshotHeight - keepWindow).
   *  - keepWindow=0 means no window protection — only minKeep applies.
   *  - Delete the rest.
   */
  pruneArchivedFiles(currentSnapshotHeight: number, minKeep: number, keepWindow: number): void {
    if (this._archivedFiles.length === 0) return;

    // null means no window protection — only minKeep applies.
    // keepWindow=0 must NOT become protectFrom=0 (that would protect everything).
    const protectFrom = keepWindow > 0 ? Math.max(0, currentSnapshotHeight - keepWindow) : null;

    const toKeepByCount = new Set<string>();
    for (let i = Math.max(0, this._archivedFiles.length - minKeep); i < this._archivedFiles.length; i++) {
      toKeepByCount.add(this._archivedFiles[i]!.filePath);
    }

    const toDelete: ArchivedFileEntry[] = [];
    const toKeep: ArchivedFileEntry[] = [];

    for (const entry of this._archivedFiles) {
      if (toKeepByCount.has(entry.filePath) || (protectFrom !== null && entry.snapshotHeight >= protectFrom)) {
        toKeep.push(entry);
      } else {
        toDelete.push(entry);
      }
    }

    for (const entry of toDelete) {
      fs.unlinkSync(entry.filePath);
    }

    this._archivedFiles = toKeep;
  }

  // ─────────────────────────────── INTERNAL ───────────────────────────────

  private async _createAndInitDataSource(filePath: string): Promise<DataSource> {
    const ds = new DataSource({
      type: 'sqlite',
      database: filePath,
      entities: this.entities,
      synchronize: false,
    } as any);
    await ds.initialize();
    const logger = { log: () => {}, warn: () => {} } as any;
    await ensureSchema(ds, this.allTableNames, logger);
    await ensureNonNegativeGuards(ds, 'sqlite', 'outbox', this.aggregateTableNames, logger);
    await applyDefaultSqlitePragmas(ds);
    return ds;
  }
}
