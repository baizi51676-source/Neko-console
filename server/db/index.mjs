/**
 * Persistence.
 *
 * SQLite via Node's built-in `node:sqlite` — no npm dependency, and the database
 * file is the single source of truth for everything the console manages.
 *
 * Why SQLite here and not "just write JSON files": the state spans several
 * related entities (sites → certificates, jobs → runs, backups → targets) and
 * concurrent writes from the scheduler and the HTTP handlers would corrupt a
 * JSON file. SQLite gives us transactions and durability for free.
 *
 * Schema notes:
 *   - `sites` stores the *desired* state; the nginx config on disk is a rendered
 *     projection of this table, exactly like `docker-compose` declares a stack.
 *   - `audit` records every privileged action: who, what, result.
 *   - timestamps are ISO strings for readability in sqlite3.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @type {DatabaseSync | null} */
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,              -- 'static' | 'proxy'
  server_names  TEXT NOT NULL,              -- comma separated
  upstream      TEXT,                       -- host:port for proxy
  root_path     TEXT,                       -- document root for static
  indexed       INTEGER NOT NULL DEFAULT 1, -- autoindex for static
  ssl           INTEGER NOT NULL DEFAULT 0,
  cert_name     TEXT,                       -- letsencrypt lineage
  php           INTEGER NOT NULL DEFAULT 0, -- rejected by the implementation
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  schedule    TEXT NOT NULL,                -- 'every:<seconds>' | cron expression
  command     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'actions' | 'script'
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run    TEXT,
  last_status TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  output      TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  result     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,               -- 'database' | 'site'
  label        TEXT NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT,
  created_at   TEXT NOT NULL
);
`;

/**
 * Open (and migrate) the database.
 *
 * @param {string} file
 */
export function openDatabase(file) {
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  // WAL keeps readers (the UI) from blocking the scheduler's writes.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

/** ISO timestamp, always UTC, always the same format. */
export function now() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* audit                                                               */
/* ------------------------------------------------------------------ */

/**
 * Record a privileged action.
 *
 * Every module writes here before responding, so the journal has a durable trail
 * independent of the application log (which rotates).
 *
 * @param {string} action  e.g. `site.create`, `cert.issue`
 * @param {string | null} target
 * @param {string} result  'ok' | 'error'
 * @param {string} [detail]
 */
export function audit(action, target, result, detail = '') {
  try {
    getDb()
      .prepare('INSERT INTO audit (at, action, target, detail, result) VALUES (?, ?, ?, ?, ?)')
      .run(now(), action, target ?? null, detail.slice(0, 2000), result);
  } catch (error) {
    // Never let an audit failure mask the operation's own outcome.
    console.error('[neko] 审计写入失败:', error.message);
  }
}

/** Recent audit rows, newest first. */
export function listAudit(limit = 100) {
  return getDb()
    .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
    .all(Math.min(500, Math.max(1, limit)));
}

/* ------------------------------------------------------------------ */
/* sites                                                               */
/* ------------------------------------------------------------------ */

export function listSites() {
  return getDb().prepare('SELECT * FROM sites ORDER BY name').all();
}

export function getSite(id) {
  return getDb().prepare('SELECT * FROM sites WHERE id = ?').get(id) ?? null;
}

export function findSiteByName(name) {
  return getDb().prepare('SELECT * FROM sites WHERE name = ?').get(name) ?? null;
}

export function insertSite(site) {
  const timestamp = now();
  getDb()
    .prepare(
      `INSERT INTO sites (id, name, kind, server_names, upstream, root_path, indexed, ssl, cert_name, php, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      site.id,
      site.name,
      site.kind,
      site.serverNames,
      site.upstream ?? null,
      site.rootPath ?? null,
      site.indexed ? 1 : 0,
      site.ssl ? 1 : 0,
      site.certName ?? null,
      site.php ? 1 : 0,
      timestamp,
      timestamp,
    );
}

export function updateSite(id, patch) {
  const current = getSite(id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: now() };
  getDb()
    .prepare(
      `UPDATE sites SET kind = ?, server_names = ?, upstream = ?, root_path = ?, indexed = ?,
       ssl = ?, cert_name = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.kind,
      next.server_names,
      next.upstream ?? null,
      next.root_path ?? null,
      next.indexed ? 1 : 0,
      next.ssl ? 1 : 0,
      next.cert_name ?? null,
      next.updated_at,
      id,
    );
  return getSite(id);
}

export function deleteSite(id) {
  getDb().prepare('DELETE FROM sites WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ */
/* jobs                                                                */
/* ------------------------------------------------------------------ */

export function listJobs() {
  return getDb().prepare('SELECT * FROM jobs ORDER BY id').all();
}

export function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
}

export function insertJob(job) {
  const info = getDb()
    .prepare('INSERT INTO jobs (name, schedule, command, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(job.name, job.schedule, job.command, job.kind ?? 'auto', job.enabled === false ? 0 : 1, now());
  return Number(info.lastInsertRowid);
}

export function updateJob(id, patch) {
  const current = getJob(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  getDb()
    .prepare('UPDATE jobs SET name = ?, schedule = ?, command = ?, kind = ?, enabled = ? WHERE id = ?')
    .run(next.name, next.schedule, next.command, next.kind, next.enabled ? 1 : 0, id);
  return getJob(id);
}

export function deleteJob(id) {
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

export function recordJobRun(jobId, startedAt, status, output) {
  getDb()
    .prepare('INSERT INTO job_runs (job_id, started_at, finished_at, status, output) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, startedAt, now(), status, String(output ?? '').slice(0, 4000));
  getDb().prepare('UPDATE jobs SET last_run = ?, last_status = ? WHERE id = ?').run(now(), status, jobId);
}

/** Keep only the newest `keep` runs per job so the table cannot grow forever. */
export function pruneJobRuns(keep = 5) {
  getDb().exec(`
    DELETE FROM job_runs WHERE id NOT IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) AS rn FROM job_runs
      ) WHERE rn <= ${Number(keep)}
    )
  `);
}

export function listJobRuns(jobId, limit = 10) {
  if (jobId) {
    return getDb()
      .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, limit);
  }
  return getDb().prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?').all(limit);
}

/* ------------------------------------------------------------------ */
/* backups                                                             */
/* ------------------------------------------------------------------ */

export function recordBackup(entry) {
  getDb()
    .prepare('INSERT INTO backups (kind, label, path, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entry.kind, entry.label, entry.path, entry.size, entry.sha256 ?? null, now());
}

export function listBackups(limit = 100) {
  return getDb().prepare('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit);
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
