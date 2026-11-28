/**
 * Database lifecycle management (create / drop only).
 *
 * Scope is deliberately narrow: create databases and users, drop them. It does
 * **not** browse tables, run queries, or export data — that is what phpMyAdmin
 * and pgAdmin exist for, and shipping a SQL console behind a web login would be a
 * far larger attack surface than the rest of this console.
 *
 * Privilege model: MySQL's root account uses `auth_socket`, so only OS root can
 * administer it. The console runs unprivileged inside a NoNewPrivileges sandbox,
 * so requests go through the same root-owned helper as nginx (see
 * deploy/db-helper.sh). Credentials never reach the console's SQLite: generated
 * passwords are returned once in the response and never persisted.
 */
import { readFile, rm } from 'node:fs/promises';
import { ApiError } from '../errors.mjs';
import { hasBinary, tryRun } from '../util.mjs';
import { writeAtomic } from './atomic.mjs';

const HELPER_DIR = '/var/lib/neko-console/helper';
const DB_REQUEST = `${HELPER_DIR}/db-request.json`;
const DB_RESULT = `${HELPER_DIR}/db-result.json`;

/* ------------------------------------------------------------------ */
/* helper transport                                                    */
/* ------------------------------------------------------------------ */

/**
 * Send one request to the privileged helper and wait for its answer.
 *
 * @param {'create'|'drop'|'list'|'ping'} op
 * @param {{ database?: string, username?: string, password?: string }} params
 * @returns {Promise<Record<string, unknown>>}
 */
export async function callHelper(op, params = {}) {
  await rm(DB_RESULT, { force: true }).catch(() => {});

  // The nonce makes a repeated identical request register as a file change, so
  // systemd re-fires the path unit.
  const payload = JSON.stringify({ op, ...params, nonce: Date.now() });
  await writeAtomic(DB_REQUEST, payload, { mode: 0o644 });

  const deadline = Date.now() + 60000;
  let raw = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    raw = await readFile(DB_RESULT, 'utf8').catch(() => null);
    if (raw !== null) break;
  }
  if (raw === null) {
    await recoverHelper();
    throw new ApiError(
      'DOCKER_ACTION_FAILED',
      '数据库辅助程序未响应',
      '请确认 deploy/neko-db-helper.path 与 .service 已安装并启用',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('DOCKER_ACTION_FAILED', '数据库辅助程序返回了无法解析的结果');
  }
  if (!parsed.ok) {
    throw new ApiError('DOCKER_ACTION_FAILED', String(parsed.message ?? '数据库操作失败'));
  }
  return parsed;
}

/** Nudge the path unit back to life after a tripped start limit. */
async function recoverHelper() {
  await tryRun('systemctl', ['reset-failed', 'neko-db-helper.path'], { timeout: 10000 });
  await tryRun('systemctl', ['start', 'neko-db-helper.path'], { timeout: 15000 });
}

/* ------------------------------------------------------------------ */
/* engines                                                             */
/* ------------------------------------------------------------------ */

/**
 * Detect which engines are usable.
 *
 * A client binary is not enough — the server must accept a connection, otherwise
 * every operation surfaces a cryptic socket error.
 */
export async function detectEngines() {
  const engines = [];

  if (hasBinary('mysql') || hasBinary('mysql', '/usr/bin')) {
    let available = false;
    let version = null;
    try {
      const result = await callHelper('ping');
      available = true;
      version = String(result.version ?? '').trim();
    } catch {
      available = false;
    }
    engines.push({
      id: 'mysql',
      label: 'MySQL / MariaDB',
      available,
      version,
      hint: available ? null : '无法连接 MySQL（需要 root 权限，请安装数据库辅助单元）',
    });
  }

  if (hasBinary('psql')) {
    const probe = await tryRun('sudo', ['-n', '-u', 'postgres', 'psql', '-tAc', 'SELECT 1'], { timeout: 8000 });
    engines.push({
      id: 'postgres',
      label: 'PostgreSQL',
      available: probe !== null,
      hint: probe === null ? '需要 postgres 用户的免密执行权限' : null,
    });
  }

  return engines;
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function checkIdentifier(value, what) {
  if (!IDENTIFIER.test(String(value ?? ''))) {
    throw new ApiError('VALIDATION_BAD_NAME', `${what}只能包含字母、数字和下划线，且以字母或下划线开头`);
  }
  return String(value);
}

/**
 * Generate a password locally.
 *
 * Generated here rather than in the helper so the plaintext never has to travel
 * anywhere except into the SQL statement.
 */
export function generatePassword(length = 24) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

/* ------------------------------------------------------------------ */
/* mysql operations                                                    */
/* ------------------------------------------------------------------ */

/** Create a database and a user that owns only that database. */
export async function createMysql({ database, username, password, charset = 'utf8mb4' }) {
  const db = checkIdentifier(database, '数据库名');
  const user = checkIdentifier(username, '用户名');
  const secret = password || generatePassword();

  const result = await callHelper('create', { database: db, username: user, password: secret });
  return {
    engine: 'mysql',
    database: db,
    username: user,
    password: secret,
    charset,
    grantedOn: db,
    message: result.message,
  };
}

/**
 * Drop a MySQL database and its user.
 *
 * `force` must be passed explicitly after a second confirmation in the UI.
 */
export async function dropMysql({ database, username, force }) {
  if (force !== true) throw new ApiError('VALIDATION_FAILED', '删除操作需要二次确认（force=true）');
  const db = checkIdentifier(database, '数据库名');
  const user = username ? checkIdentifier(username, '用户名') : null;

  await callHelper('drop', { database: db, username: user ?? '' });
  return { engine: 'mysql', database: db, username: user, dropped: true };
}

/** List databases, used only to warn about name collisions. No data exposed. */
export async function listMysqlDatabases() {
  const result = await callHelper('list');
  return Array.isArray(result.databases) ? result.databases.map(String) : [];
}

/* ------------------------------------------------------------------ */
/* postgres operations                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create a PostgreSQL database and its owning role.
 *
 * PostgreSQL has no auth_socket equivalent, so this uses the `postgres` OS user
 * through a narrowly scoped sudo rule (deploy/sudoers). It is only attempted when
 * that rule exists.
 */
export async function createPostgres({ database, username, password }) {
  const db = checkIdentifier(database, '数据库名');
  const user = checkIdentifier(username, '用户名');
  const secret = password || generatePassword();

  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

  const role = await tryRun(
    'sudo',
    ['-n', '-u', 'postgres', 'psql', '-tAc', `SELECT 1 FROM pg_roles WHERE rolname = ${quote(user)}`],
    { timeout: 20000 },
  );
  if (role === null) {
    throw new ApiError('DOCKER_NO_PERMISSION', '无法以 postgres 用户运行 psql（缺少 sudo 规则）');
  }

  const roleSql = role.trim() === '1'
    ? `ALTER ROLE "${user}" WITH LOGIN PASSWORD ${quote(secret)}`
    : `CREATE ROLE "${user}" LOGIN PASSWORD ${quote(secret)}`;
  const roleResult = await tryRun('sudo', ['-n', '-u', 'postgres', 'psql', '-c', roleSql], { timeout: 20000 });
  if (roleResult === null) throw new ApiError('DOCKER_ACTION_FAILED', '创建或更新角色失败');

  // CREATE DATABASE cannot run inside a transaction block, so it is its own call.
  const dbResult = await tryRun(
    'sudo',
    ['-n', '-u', 'postgres', 'psql', '-c', `CREATE DATABASE "${db}" OWNER "${user}"`],
    { timeout: 20000 },
  );
  if (dbResult === null) throw new ApiError('DOCKER_ACTION_FAILED', '创建数据库失败（可能已存在）');

  return { engine: 'postgres', database: db, username: user, password: secret, owner: user };
}

export async function dropPostgres({ database, username, force }) {
  if (force !== true) throw new ApiError('VALIDATION_FAILED', '删除操作需要二次确认（force=true）');
  const db = checkIdentifier(database, '数据库名');

  const dropped = await tryRun(
    'sudo',
    ['-n', '-u', 'postgres', 'psql', '-c', `DROP DATABASE IF EXISTS "${db}"`],
    { timeout: 20000 },
  );
  if (dropped === null) throw new ApiError('DOCKER_ACTION_FAILED', '删除数据库失败');

  if (!username) return { engine: 'postgres', database: db, dropped: true };

  const user = checkIdentifier(username, '用户名');
  const droppedRole = await tryRun(
    'sudo',
    ['-n', '-u', 'postgres', 'psql', '-c', `DROP ROLE IF EXISTS "${user}"`],
    { timeout: 20000 },
  );
  if (droppedRole === null) {
    return {
      engine: 'postgres',
      database: db,
      dropped: true,
      roleDropped: false,
      note: '角色仍拥有其他对象，未删除',
    };
  }
  return { engine: 'postgres', database: db, username: user, dropped: true, roleDropped: true };
}

/**
 * Dump one MySQL database through the privileged helper.
 *
 * Kept here (rather than in backup.mjs) because it needs the same root path as
 * the other MySQL operations: mysqldump cannot authenticate with auth_socket
 * from an unprivileged process.
 *
 * @param {string} database
 */
export async function dumpMysqlViaHelper(database) {
  const db = checkIdentifier(database, '数据库名');
  const result = await callHelper('dump', { database: db });
  return {
    path: String(result.path ?? ''),
    size: Number(result.size ?? 0),
    sha256: String(result.sha256 ?? ''),
  };
}

export async function listPostgresDatabases() {
  const output = await tryRun(
    'sudo',
    ['-n', '-u', 'postgres', 'psql', '-tAc',
      "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres'"],
    { timeout: 20000 },
  );
  if (output === null) return [];
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Engine-agnostic dispatch used by the route. */
export async function listDatabases(engine) {
  if (engine === 'mysql') return listMysqlDatabases();
  if (engine === 'postgres') return listPostgresDatabases();
  throw new ApiError('VALIDATION_BAD_ACTION', '未知的数据库引擎');
}
