/**
 * Configuration.
 *
 * Precedence: environment variables > config file > defaults. The config file
 * lives outside the source tree (`/etc/neko-console/` by default) so a packaged
 * install can be replaced without touching secrets. `neko init` writes it.
 *
 * @typedef {object} Config
 * @property {number} port
 * @property {string} host
 * @property {string} username
 * @property {string} passwordHash
 * @property {string} sessionSecret
 * @property {number} sessionTtl
 * @property {string} fileRoot
 * @property {string} databaseFile
 * @property {string} staticRoot
 * @property {number} loginMaxAttempts
 * @property {number} loginWindow
 * @property {boolean} enableTerminal
 * @property {string | undefined} tlsCert
 * @property {string | undefined} tlsKey
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const CONFIG_DIR = process.env.NEKO_CONFIG_DIR ?? '/etc/neko-console';
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

/** Read the JSON config file, tolerating its absence. */
function readFileConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析配置文件 ${CONFIG_FILE}: ${error.message}`);
  }
}

/**
 * @returns {Config}
 */
export function loadConfig() {
  const file = readFileConfig();

  if (file.port && process.env.NEKO_PORT === undefined) {
    // envNumber already falls back to file.port; read it before defaults so a
    // config file value is not silently replaced by the hard-coded default.
    process.env.NEKO_PORT = String(file.port);
  }

  /** @type {Config} */
  const config = {
    port: envNumber('NEKO_PORT', 8737),
    host: process.env.NEKO_HOST ?? file.host ?? '0.0.0.0',
    username: process.env.NEKO_USERNAME ?? file.username ?? 'admin',
    passwordHash: process.env.NEKO_PASSWORD_HASH ?? file.passwordHash ?? '',
    sessionSecret: process.env.NEKO_SESSION_SECRET ?? file.sessionSecret ?? '',
    sessionTtl: envNumber('NEKO_SESSION_TTL', file.sessionTtl ?? 12 * 60 * 60),
    fileRoot: resolve(process.env.NEKO_FILE_ROOT ?? file.fileRoot ?? join(homedir(), 'neko-files')),
    staticRoot: resolve(process.env.NEKO_STATIC_ROOT ?? file.staticRoot ?? join(process.cwd(), 'dist')),
    
    databaseFile: resolve(
      process.env.NEKO_DB_FILE ?? file.databaseFile ?? join(homedir(), '.neko-console', 'neko.sqlite'),
    ),
    loginMaxAttempts: envNumber('NEKO_LOGIN_MAX', file.loginMaxAttempts ?? 8),
    loginWindow: envNumber('NEKO_LOGIN_WINDOW', file.loginWindow ?? 15 * 60),
    enableTerminal: envBool('NEKO_TERMINAL', file.enableTerminal ?? true),
    tlsCert: process.env.NEKO_TLS_CERT ?? file.tlsCert,
    tlsKey: process.env.NEKO_TLS_KEY ?? file.tlsKey,
  };

  if (!config.passwordHash) {
    throw new Error(
      '尚未设置管理员密码。请先运行 `neko init` 生成配置（或设置 NEKO_PASSWORD_HASH 环境变量）。',
    );
  }

  // A missing secret would make cookies forgeable across restarts; generate a
  // process-local one and warn rather than shipping a weak constant.
  if (!config.sessionSecret) {
    config.sessionSecret = randomBytes(32).toString('base64');
    console.warn('[neko] 未配置 sessionSecret，已生成本次运行专用密钥（重启后需重新登录）');
  }

  return config;
}
