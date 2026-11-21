/**
 * Processes, filesystems and network detail from /proc.
 */
import { readdir, readFile, readlink } from 'node:fs/promises';
import { round, tryRun } from '../util.mjs';

const PAGE_SIZE = 4096;
let pageSize = PAGE_SIZE;

/** Read the real page size once; sysconf via getconf avoids a hard-coded guess. */
async function resolvePageSize() {
  const out = await tryRun('getconf', ['PAGESIZE']);
  const value = Number((out ?? '').trim());
  if (Number.isFinite(value) && value > 0) pageSize = value;
}

/**
 * List processes with CPU and memory usage.
 *
 * RSS comes from statm and CPU time from stat's utime+stime. Percentages are
 * computed against total system jiffies since boot so they mean the same thing
 * as `ps aux` figures (average over process lifetime, not instantaneous).
 */
export async function getProcesses() {
  if (pageSize === PAGE_SIZE) await resolvePageSize();

  const [statOut, meminfo] = await Promise.all([tryRun('cat', ['/proc/stat']), tryRun('cat', ['/proc/meminfo'])]);
  const cpuLine = statOut?.split('\n').find((line) => line.startsWith('cpu '));
  const cpuFields = cpuLine ? cpuLine.trim().split(/\s+/).slice(1).map(Number) : [];
  const totalJiffies = cpuFields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) || 1;

  const memTotal = Number(meminfo?.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0) * 1024;

  let pids;
  try {
    pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }

  const processes = [];
  for (const pid of pids) {
    try {
      const [stat, status, cmdline] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
      ]);

      // The comm field is wrapped in parentheses and may itself contain spaces
      // or parentheses, so parse from the LAST ')' rather than splitting blindly.
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      // fields[0] is state (field 3 in proc(5)); utime is field 14 → index 11.
      const state = fields[0];
      const utime = Number(fields[11] ?? 0);
      const stime = Number(fields[12] ?? 0);
      const threads = Number(fields[17] ?? 1);
      const starttime = Number(fields[19] ?? 0);

      const rssMatch = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
      const rss = rssMatch ? Number(rssMatch[1]) * 1024 : 0;
      const uidMatch = status.match(/^Uid:\s+(\d+)/m);
      const uid = uidMatch ? Number(uidMatch[1]) : 0;

      const cpuPercent = ((utime + stime) / totalJiffies) * 100;

      processes.push({
        pid: Number(pid),
        name,
        command: cmdline ? cmdline.replace(/\0/g, ' ').trim().slice(0, 512) : `[${name}]`,
        state,
        cpu: round(cpuPercent, 1),
        memory: rss,
        memoryPercent: memTotal > 0 ? round((rss / memTotal) * 100, 1) : 0,
        threads,
        uid,
        started: starttime,
      });
    } catch {
      // Process exited between readdir and read, or is not ours to read.
      continue;
    }
  }

  return processes.sort((a, b) => b.cpu - a.cpu || b.memory - a.memory);
}

/**
 * Read a single process's detail, including its working directory and the
 * executable it runs. Used by the process detail drawer.
 *
 * @param {number} pid
 */
export async function getProcessDetail(pid) {
  const [status, cmdline, cwd, exe, environ] = await Promise.all([
    readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
    readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
    readlink(`/proc/${pid}/cwd`).catch(() => null),
    readlink(`/proc/${pid}/exe`).catch(() => null),
    readFile(`/proc/${pid}/environ`, 'utf8').catch(() => ''),
  ]);

  const fields = {};
  for (const line of status.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }

  // Environment is NUL-separated. Secrets live here, so names are listed but
  // values are only included for keys that are obviously not credentials.
  const envEntries = environ
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      return eq < 0 ? { key: entry, value: '' } : { key: entry.slice(0, eq), value: entry.slice(eq + 1) };
    });
  const REDACT = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
  const env = envEntries.map(({ key, value }) => ({
    key,
    value: REDACT.test(key) ? '••••••••' : value.slice(0, 300),
  }));

  return {
    pid: Number(pid),
    name: fields.Name ?? cmdline.split('\0')[0] ?? '',
    state: fields.State ?? '',
    threads: Number(fields.Threads ?? 1) ?? 1,
    vmRss: Number((fields.VmRSS ?? '0').replace(/\D/g, '')) * 1024,
    vmSize: Number((fields.VmSize ?? '0').replace(/\D/g, '')) * 1024,
    exe,
    cwd,
    command: cmdline.replace(/\0/g, ' ').trim(),
    env,
    fields,
  };
}

/* ------------------------------------------------------------------ */
/* mounts                                                              */
/* ------------------------------------------------------------------ */

export async function getMounts() {
  const mounts = await tryRun('cat', ['/proc/mounts']);
  if (!mounts) return [];
  return mounts
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3)
    .map(([device, mount, fstype, options]) => ({ device, mount, fstype, options }))
    .filter((entry) => entry.fstype !== 'cgroup' && entry.fstype !== 'cgroup2');
}

/* ------------------------------------------------------------------ */
/* uptime / who                                                        */
/* ------------------------------------------------------------------ */

export async function getSessions() {
  const out = await tryRun('who', []);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return { user: parts[0] ?? '', terminal: parts[1] ?? '', since: parts.slice(2, 4).join(' ') };
    });
}
