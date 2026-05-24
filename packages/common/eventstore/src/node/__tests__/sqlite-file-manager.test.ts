import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteFileManager } from '../sqlite-file-manager';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'efm-test-'));
}

function touch(filePath: string): void {
  fs.writeFileSync(filePath, '');
}

function makeManager(dir: string): SqliteFileManager {
  return new SqliteFileManager(dir, [] as any, [], []);
}

function getArchivedFiles(mgr: SqliteFileManager): any[] {
  return (mgr as any)._archivedFiles;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SqliteFileManager', () => {
  // ── ARCHIVED FILE NAME PARSING ─────────────────────────────────────────────

  describe('archived filename regex', () => {
    const RE = /^(\d+)-(\d+)\.sqlite3$/;

    it('parses "0-10000.sqlite3"', () => {
      const m = RE.exec('0-10000.sqlite3');
      expect(m).not.toBeNull();
      expect(parseInt(m![1]!, 10)).toBe(0);
      expect(parseInt(m![2]!, 10)).toBe(10000);
    });

    it('parses "10001-25000.sqlite3"', () => {
      const m = RE.exec('10001-25000.sqlite3');
      expect(m).not.toBeNull();
      expect(parseInt(m![1]!, 10)).toBe(10001);
      expect(parseInt(m![2]!, 10)).toBe(25000);
    });

    it('does not match "current.sqlite3"', () => {
      expect(RE.exec('current.sqlite3')).toBeNull();
    });

    it('does not match "new.sqlite3"', () => {
      expect(RE.exec('new.sqlite3')).toBeNull();
    });

    it('does not match filenames without digits', () => {
      expect(RE.exec('archive.sqlite3')).toBeNull();
    });
  });

  // ── _recoverIfNeeded ───────────────────────────────────────────────────────

  describe('_recoverIfNeeded()', () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('does nothing when new.sqlite3 is absent', () => {
      const mgr = makeManager(dir);
      expect(() => (mgr as any)._recoverIfNeeded()).not.toThrow();
    });

    it('deletes new.sqlite3 when both new.sqlite3 and current.sqlite3 exist (state A)', () => {
      touch(path.join(dir, 'new.sqlite3'));
      touch(path.join(dir, 'current.sqlite3'));
      const mgr = makeManager(dir);
      (mgr as any)._recoverIfNeeded();
      expect(fs.existsSync(path.join(dir, 'new.sqlite3'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'current.sqlite3'))).toBe(true);
    });

    it('renames new.sqlite3 → current.sqlite3 when only new.sqlite3 exists (state B)', () => {
      touch(path.join(dir, 'new.sqlite3'));
      const mgr = makeManager(dir);
      (mgr as any)._recoverIfNeeded();
      expect(fs.existsSync(path.join(dir, 'new.sqlite3'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'current.sqlite3'))).toBe(true);
    });
  });

  // ── pruneArchivedFiles ────────────────────────────────────────────────────

  describe('pruneArchivedFiles()', () => {
    let dir: string;

    beforeEach(() => { dir = makeTmpDir(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function makeArchivedEntry(fromH: number, snapH: number): any {
      const fp = path.join(dir, `${fromH}-${snapH}.sqlite3`);
      touch(fp);
      return { filePath: fp, fromHeight: fromH, snapshotHeight: snapH };
    }

    it('does nothing when archivedFiles is empty', () => {
      const mgr = makeManager(dir);
      expect(() => mgr.pruneArchivedFiles(50000, 2, 10000)).not.toThrow();
    });

    it('keeps all files when count <= minKeep', () => {
      const mgr = makeManager(dir);
      (mgr as any)._archivedFiles = [
        makeArchivedEntry(0, 10000),
        makeArchivedEntry(10001, 20000),
      ];
      mgr.pruneArchivedFiles(20000, 3, 0);
      expect(getArchivedFiles(mgr)).toHaveLength(2);
      expect(fs.existsSync(path.join(dir, '0-10000.sqlite3'))).toBe(true);
    });

    it('deletes files with snapshotHeight below (currentSnapshotHeight - keepWindow)', () => {
      const mgr = makeManager(dir);
      (mgr as any)._archivedFiles = [
        makeArchivedEntry(0, 5000),
        makeArchivedEntry(5001, 20000),
        makeArchivedEntry(20001, 35000),
        makeArchivedEntry(35001, 50000),
      ];
      mgr.pruneArchivedFiles(50000, 1, 20000);
      const remaining = getArchivedFiles(mgr);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((e: any) => e.snapshotHeight)).toEqual([35000, 50000]);
      expect(fs.existsSync(path.join(dir, '0-5000.sqlite3'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '5001-20000.sqlite3'))).toBe(false);
    });

    it('always keeps at least minKeep most recent files regardless of keepWindow', () => {
      const mgr = makeManager(dir);
      (mgr as any)._archivedFiles = [
        makeArchivedEntry(0, 1000),
        makeArchivedEntry(1001, 2000),
        makeArchivedEntry(2001, 3000),
      ];
      mgr.pruneArchivedFiles(3000, 2, 0);
      const remaining = getArchivedFiles(mgr);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((e: any) => e.snapshotHeight)).toEqual([2000, 3000]);
    });
  });
});
