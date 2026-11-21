/**
 * Shared helpers for the Neko-console backend.
 *
 * Deliberately dependency-free: the console must run on a bare Linux box with
 * nothing but Node 20+, so no npm packages are used on the server side. These
 * are plain `.mjs` modules (no TypeScript), so shapes are documented with
 * JSDoc instead of type annotations.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve, sep } from 'node:path';

export const IS_LINUX = platform() === 'linux';

/**
 * Run a command and resolve with stdout.
 *
 * Uses execFile (not exec) so arguments are never shell-interpreted — command
 * injection through a unit name or container id is impossible by construction.
 * A non-zero exit rejects with stderr attached, because callers want to surface
 * the real reason from tools like systemctl.
 *
 * @param {string} file
 * @param {string[]} [args]
 * @param {{ timeout?: number, maxBuffer?: number, input?: string }} [options]
 * @returns {Promise<string>}
 */
export function run(file, args = [], options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 8000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        encoding: 'utf8',
        // A clean environment avoids inheriting TERM/COLORTERM, which makes
        // tools emit ANSI escapes we would then have to strip.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout || error.message || '').trim();
          const wrapped = new Error(message || `${file} exited non-zero`);
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolvePromise(stdout);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/**
 * Like run(), but resolves `null` instead of rejecting.
 *
 * @param {string} file
 * @param {string[]} [args]
 * @param {{ timeout?: number, maxBuffer?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function tryRun(file, args = [], options = {}) {
  try {
    return await run(file, args, options);
  } catch {
    return null;
  }
}

/** True when a binary exists on PATH. Cached because it is called per request. */
const binaryCache = new Map();

/** @param {string} name @returns {boolean} */
export function hasBinary(name) {
  const cached = binaryCache.get(name);
  if (cached !== undefined) return cached;
  const dirs = (process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
  const found = dirs.some((dir) => existsSync(`${dir}/${name}`));
  binaryCache.set(name, found);
  return found;
}

/**
 * Strip ANSI escapes — log files and journalctl output are full of them.
 * @param {string} text
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/** Round to `digits` decimals without trailing float noise. */
export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

/**
 * Validate an identifier from the client before it reaches a command line:
 * systemd unit names, container names and PIDs all have strict shapes.
 *
 * @param {string} value
 * @param {RegExp} [pattern]
 */
export function isSafeToken(value, pattern = /^[A-Za-z0-9@._:+-]{1,128}$/) {
  return typeof value === 'string' && pattern.test(value);
}

/**
 * Resolve a client-supplied path and confirm it stays inside an allowed root.
 *
 * Every filesystem endpoint funnels through here. `path.resolve` collapses
 * `..` segments first, then the prefix check runs against the *resolved* path,
 * so `../../etc/shadow` cannot escape.
 *
 * @param {string} root
 * @param {string} requested
 * @returns {string | null}
 */
export function resolveWithin(root, requested) {
  const base = resolve(root);
  const target = resolve(base, requested || '.');
  if (target === base) return target;
  return target.startsWith(base + sep) ? target : null;
}

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Human-readable byte count, for log lines only (the UI formats its own). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${round(bytes / 1024 ** index, 1)} ${units[index]}`;
}
