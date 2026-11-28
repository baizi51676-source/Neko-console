/**
 * systemd services, journald logs, and system log files.
 *
 * Everything degrades to an empty list when systemd or journald is absent
 * (container, non-systemd distro) rather than throwing, so the UI can show
 * "unavailable" instead of an error page.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { hasBinary, isSafeToken, stripAnsi, tryRun } from '../util.mjs';
import { ApiError } from '../errors.mjs';

/* ------------------------------------------------------------------ */
/* services                                                            */
/* ------------------------------------------------------------------ */

const UNITS_CACHE_MS = 1500;
let unitsCache = { at: 0, value: /** @type {any[]} */ ([]) };

/**
 * List systemd units with their active/sub states.
 *
 * `systemctl list-units --output=json` exists only on newer systemd, so this
 * parses the stable plain-text columns instead and keeps a short cache: the
 * dashboard refreshes often and unit listing is comparatively expensive.
 */
export async function getServices(force = false) {
  if (!hasBinary('systemctl')) return { available: false, units: [] };
  const now = Date.now();
  if (!force && now - unitsCache.at < UNITS_CACHE_MS) {
    return { available: true, units: unitsCache.value };
  }

  const out = await tryRun('systemctl', [
    'list-units',
    '--type=service',
    '--all',
    '--no-pager',
    '--no-legend',
    '--plain',
  ]);
  if (!out) return { available: false, units: [] };

  const units = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Columns: UNIT LOAD ACTIVE SUB DESCRIPTION
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, name, load, active, sub, description] = match;
    units.push({
      name: name.replace(/\.service$/, ''),
      fullName: name,
      load,
      active,
      sub,
      description: description.trim(),
    });
  }

  unitsCache = { at: now, value: units };
  return { available: true, units };
}

/**
 * Perform a start/stop/restart/enable/disable action on one unit.
 *
 * The unit name is validated against a strict character set *and* checked to
 * live under `services` state — plus execFile means no shell is ever involved.
 *
 * @param {string} action
 * @param {string} unit
 */
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

export async function controlService(action, unit) {
  if (!ALLOWED_ACTIONS.has(action)) throw new ApiError('VALIDATION_BAD_ACTION', `不支持的操作: ${action}`);
  if (!isSafeToken(unit, /^[A-Za-z0-9@._:+-]{1,200}$/)) throw new ApiError('VALIDATION_BAD_NAME', '无效的服务名');
  const out = await tryRun('systemctl', [action, `${unit}.service`], { timeout: 20000 });
  if (out === null) throw new ApiError('DOCKER_ACTION_FAILED', `systemctl ${action} ${unit} 执行失败（可能缺少权限）`);
  unitsCache.at = 0; // invalidate so the next poll sees the new state
  return { ok: true };
}

/** Journal lines for one unit, newest last. */
export async function getServiceLogs(unit, lines = 200) {
  if (!isSafeToken(unit, /^[A-Za-z0-9@._:+-]{1,200}$/)) throw new ApiError('VALIDATION_BAD_NAME', '无效的服务名');
  if (!hasBinary('journalctl')) return { available: false, lines: [] };
  const count = Math.min(2000, Math.max(1, Number(lines) || 200));
  const out = await tryRun(
    'journalctl',
    ['-u', `${unit}.service`, '-n', String(count), '--no-pager', '--output=short-iso'],
    { timeout: 12000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (out === null) return { available: false, lines: [] };
  return { available: true, lines: parseLogLines(out) };
}

/* ------------------------------------------------------------------ */
/* logs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse a block of log text into structured rows.
 *
 * Lines are kept whole (not wrapped) so the viewer can show them in a <pre>
 * without breaking long stack traces across rows.
 *
 * @param {string} text
 */
export function parseLogLines(text) {
  return stripAnsi(text)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      // `short-iso` yields: 2024-01-01T00:00:00+0000 host unit[pid]: message
      const iso = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})\s+(\S+)\s+([^:]+):\s?(.*)$/);
      if (iso) {
        return { index, time: iso[1], host: iso[2], source: iso[3], message: iso[4], raw: line };
      }
      // syslog style: Jan  1 00:00:00 host unit[pid]: message
      const syslog = line.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s?(.*)$/);
      if (syslog) {
        return { index, time: syslog[1], host: syslog[2], source: syslog[3], message: syslog[4], raw: line };
      }
      return { index, time: null, host: null, source: null, message: line, raw: line };
    });
}

/** Read the tail of a system log file. */
export async function getSystemLog(path, lines = 300) {
  const SAFE_PATHS = ['/var/log/syslog', '/var/log/messages', '/var/log/kern.log', '/var/log/auth.log', '/var/log/dmesg'];
  if (!SAFE_PATHS.includes(path)) throw new ApiError('FS_LOG_FORBIDDEN', '不允许读取该日志文件');
  const count = Math.min(5000, Math.max(1, Number(lines) || 300));

  const info = await stat(path).catch(() => null);
  if (!info) return { available: false, lines: [] };

  // `tail` streams from the end instead of loading a possibly huge file.
  const out = await tryRun('tail', ['-n', String(count), path], { maxBuffer: 8 * 1024 * 1024 });
  if (out === null) return { available: false, lines: [] };
  return { available: true, lines: parseLogLines(out), size: info.size };
}

/** Which known log files actually exist on this host. */
export async function listSystemLogs() {
  const candidates = ['/var/log/syslog', '/var/log/messages', '/var/log/kern.log', '/var/log/auth.log'];
  const result = [];
  for (const path of candidates) {
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) result.push({ path, size: info.size, modified: info.mtime.toISOString() });
  }

  // Also surface rotated archives so old incidents are reachable.
  try {
    const entries = await readdir('/var/log');
    for (const entry of entries) {
      if (!/\.(log|txt)(\.\d+|\.gz)?$/.test(entry)) continue;
      if (candidates.some((candidate) => candidate.endsWith(`/${entry}`))) continue;
      const info = await stat(`/var/log/${entry}`).catch(() => null);
      if (info?.isFile() && info.size > 0) {
        result.push({ path: `/var/log/${entry}`, size: info.size, modified: info.mtime.toISOString() });
      }
    }
  } catch {
    /* /var/log unreadable */
  }
  return result.slice(0, 40);
}

/** Journal lines across the whole system, optionally filtered. */
export async function getJournal(lines = 300, priority = 'all') {
  if (!hasBinary('journalctl')) return { available: false, lines: [] };
  const count = Math.min(5000, Math.max(1, Number(lines) || 300));
  const args = ['-n', String(count), '--no-pager', '--output=short-iso'];
  if (priority && priority !== 'all') args.push(`--priority=${priority}`);
  const out = await tryRun('journalctl', args, { timeout: 12000, maxBuffer: 8 * 1024 * 1024 });
  if (out === null) return { available: false, lines: [] };
  return { available: true, lines: parseLogLines(out) };
}

export { readFile };
