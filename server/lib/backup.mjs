/**
 * Backups.
 *
 * Two independent kinds, because they fail differently:
 *   - **database**: a logical dump via `mysqldump` / `pg_dump`. Must never use a
 *     shell, and must run inside a transaction so the dump is consistent.
 *   - **site**: a tar of a directory tree, with exclusions and symlinks not
 *     followed (a symlink pointing outside the tree would otherwise pull in
 *     unrelated data or loop).
 *
 * Every archive gets a SHA-256 so a restore can verify it is complete before
 * being trusted. Retention is counted per kind so a busy database backup does not
 * evict the site backups.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../errors.mjs';
import { run, tryRun } from '../util.mjs';
import { recordBackup, listBackups, now } from '../db/index.mjs';

/** Where archives are written. Must be writable by the service user. */
export const BACKUP_DIR = process.env.NEKO_BACKUP_DIR ?? '/var/backups/neko-console';
/** How many archives of each kind to keep. */
const KEEP = Number(process.env.NEKO_BACKUP_KEEP ?? 5);
/** Dumps larger than this are still attempted, but the timeout will stop them. */
const DUMP_TIMEOUT_MS = 300_000;

/**
 * Stream a file through SHA-256.
 *
 * Streamed rather than read whole: a database dump can be gigabytes, and
 * `readFile` on it would take the process out.
 *
 * @param {string} path
 */
export async function hashFile(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** Timestamp fragment for filenames: sortable, no colons. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function ensureBackupDir() {
  await mkdir(BACKUP_DIR, { recursive: true, mode: 0o750 });
}

/**
 * Back up one MySQL database through the privileged helper.
 *
 * `mysqldump` needs root for auth_socket, so this goes through the same helper as
 * the other database operations. `--single-transaction` (inside the helper) gives
 * a consistent snapshot of InnoDB tables without locking them, which is what lets
 * this run against a live server.
 */
export async function backupMysql(database) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(database)) {
    throw new ApiError('VALIDATION_BAD_NAME', '无效的数据库名');
  }
  await ensureBackupDir();

  const { dumpMysqlViaHelper } = await import('./database.mjs');
  const result = await dumpMysqlViaHelper(database);

  recordBackup({
    kind: 'database',
    label: `mysql:${database}`,
    path: result.path,
    size: result.size,
    sha256: result.sha256,
  });

  return {
    kind: 'database',
    label: `mysql:${database}`,
    path: result.path,
    size: result.size,
    sha256: result.sha256,
    createdAt: now(),
  };
}

/** Same for PostgreSQL. `--no-owner` makes the dump restorable by any role. */
export async function backupPostgres(database) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(database)) {
    throw new ApiError('VALIDATION_BAD_NAME', '无效的数据库名');
  }
  await ensureBackupDir();

  const plain = join(BACKUP_DIR, `postgres-${database}-${stamp()}.sql`);
  const dumped = await tryRun(
    'sudo',
    ['-n', '-u', 'postgres', 'pg_dump', '--no-owner', '--clean', '--if-exists', '-f', plain, database],
    { timeout: DUMP_TIMEOUT_MS },
  );
  if (dumped === null) throw new ApiError('DOCKER_ACTION_FAILED', 'pg_dump 执行失败');

  const zipped = await tryRun('gzip', ['-f', plain], { timeout: DUMP_TIMEOUT_MS });
  if (zipped === null) throw new ApiError('DOCKER_ACTION_FAILED', 'gzip 压缩失败');

  const path = `${plain}.gz`;
  const info = await stat(path);
  const sha256 = await hashFile(path);
  recordBackup({ kind: 'database', label: `postgres:${database}`, path, size: info.size, sha256 });

  return { kind: 'database', label: `postgres:${database}`, path, size: info.size, sha256, createdAt: now() };
}

/** Resolve how to authenticate mysqldump, mirroring the database module. */
async function mysqlAuthPrefix() {
  const direct = await tryRun('mysql', ['-e', 'SELECT 1'], { timeout: 6000 });
  if (direct !== null) return ['mysqldump'];
  const viaSudo = await tryRun('sudo', ['-n', 'mysql', '-e', 'SELECT 1'], { timeout: 6000 });
  if (viaSudo !== null) return ['sudo', '-n', 'mysqldump'];
  throw new ApiError('DOCKER_NO_PERMISSION', '无法以 root 身份运行 mysqldump');
}

/**
 * Tar a directory tree.
 *
 * `--exclude` entries are relative to the root, matching tar's own semantics.
 * `-h` is deliberately NOT passed: following symlinks can pull in the whole
 * filesystem or loop forever.
 *
 * @param {{ label: string, path: string, excludes?: string[] }} target
 */
export async function backupSite({ label, path: sourcePath, excludes = [] }) {
  if (!sourcePath?.startsWith('/')) throw new ApiError('VALIDATION_BAD_PATH', '站点目录必须是绝对路径');
  const info = await stat(sourcePath).catch(() => null);
  if (!info?.isDirectory()) throw new ApiError('NOTFOUND_FILE', `目录不存在: ${sourcePath}`);

  await ensureBackupDir();
  const safeLabel = String(label ?? 'site').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const path = join(BACKUP_DIR, `site-${safeLabel}-${stamp()}.tar.gz`);

  const args = ['-czf', path, '-C', sourcePath];
  // Sensible defaults: node_modules and VCS metadata are noise in a site backup.
  for (const exclude of ['node_modules', '.git', ...excludes]) {
    const cleaned = String(exclude).trim();
    if (!cleaned) continue;
    args.push(`--exclude=${cleaned}`);
  }
  args.push('.');

  const tarred = await tryRun('tar', args, { timeout: DUMP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  if (tarred === null) throw new ApiError('DOCKER_ACTION_FAILED', 'tar 打包失败');

  const archive = await stat(path);
  const sha256 = await hashFile(path);
  recordBackup({ kind: 'site', label: safeLabel, path, size: archive.size, sha256 });

  return { kind: 'site', label: safeLabel, path, size: archive.size, sha256, createdAt: now() };
}

/**
 * Detect which MySQL databases exist, so "back up everything" knows what to ask for.
 *
 * Goes through the database helper for the same reason the dump does: unprivileged
 * `mysql` cannot authenticate against auth_socket. Returns an empty list rather
 * than throwing — a host without MySQL is normal and should not fail the backup.
 */
export async function discoverDatabases() {
  const found = [];
  try {
    const { listMysqlDatabases } = await import('./database.mjs');
    for (const database of await listMysqlDatabases()) {
      found.push({ engine: 'mysql', database });
    }
  } catch {
    // MySQL absent or helper not installed; the site half of the backup still runs.
  }
  return found;
}

/** Back up every discovered database plus every configured site. */
export async function runFullBackup() {
  const files = [];
  const failures = [];

  for (const entry of await discoverDatabases()) {
    try {
      files.push(await backupMysql(entry.database));
    } catch (error) {
      failures.push(`mysql:${entry.database}: ${error.message}`);
    }
  }

  // Sites come from the database, so the same list the UI shows is what gets
  // archived — no separate inventory to drift.
  const { listSites } = await import('../db/index.mjs');
  for (const site of listSites()) {
    if (site.kind !== 'static' || !site.root_path) continue;
    try {
      files.push(await backupSite({ label: site.name, path: site.root_path }));
    } catch (error) {
      failures.push(`site:${site.name}: ${error.message}`);
    }
  }

  await pruneBackups();
  return {
    files,
    failures,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
  };
}

/**
 * Delete old archives, keeping the newest KEEP of each kind.
 *
 * Counted per kind so a frequent database job cannot evict site backups.
 */
export async function pruneBackups() {
  const all = listBackups(500);
  const byKind = new Map();
  for (const entry of all) {
    const bucket = byKind.get(entry.kind) ?? [];
    bucket.push(entry);
    byKind.set(entry.kind, bucket);
  }

  const removed = [];
  for (const [, bucket] of byKind) {
    // `listBackups` is newest-first, so anything past KEEP is old.
    for (const entry of bucket.slice(KEEP)) {
      await unlink(entry.path).catch(() => {});
      removed.push(entry.path);
    }
  }
  return removed;
}

/** Inventory for the UI, with sizes summed by kind. */
export async function backupSummary() {
  const entries = listBackups(100);
  const totals = { database: 0, site: 0 };
  for (const entry of entries) totals[entry.kind] = (totals[entry.kind] ?? 0) + entry.size;
  return {
    entries,
    totalSize: totals.database + totals.site,
    keep: KEEP,
    dir: BACKUP_DIR,
  };
}

/**
 * Verify an archive against its recorded hash.
 *
 * Used by the "verify" action: a backup nobody checked is a hope, not a backup.
 */
export async function verifyBackup(path) {
  const entries = listBackups(500).filter((entry) => entry.path === path);
  if (entries.length === 0) throw new ApiError('NOTFOUND_FILE', '备份记录不存在');
  const record = entries[0];

  const exists = await stat(path).catch(() => null);
  if (!exists) return { ok: false, reason: '文件已不存在', path };

  const actual = await hashFile(path);
  return {
    ok: actual === record.sha256,
    path,
    expected: record.sha256,
    actual,
    size: exists.size,
  };
}

/** List files in the backup dir that are not tracked (leftovers). */
export async function orphans() {
  const tracked = new Set(listBackups(500).map((entry) => entry.path));
  const entries = await readdir(BACKUP_DIR).catch(() => []);
  const result = [];
  for (const entry of entries) {
    const path = join(BACKUP_DIR, entry);
    if (!tracked.has(path)) result.push(path);
  }
  return result;
}

export { run };
