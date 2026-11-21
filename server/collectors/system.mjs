/**
 * System metrics.
 *
 * On Linux everything comes from /proc and /sys rather than shelling out to
 * `top`/`df`/`free`: those tools print human-formatted, locale-dependent text,
 * whereas /proc is a stable machine-readable interface and needs no subprocess.
 *
 * CPU usage and network rates are *deltas* between samples, so this module keeps
 * the previous snapshot in module state. The UI polls on a fixed interval, which
 * makes a simple difference-over-elapsed accurate enough.
 */
import { readdir, readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg, uptime as osUptime, hostname, platform, release, arch } from 'node:os';
import { round, tryRun } from '../util.mjs';

/* ------------------------------------------------------------------ */
/* CPU                                                                 */
/* ------------------------------------------------------------------ */

/** @type {{ idle: number, total: number } | null} */
let previousCpu = null;

/** Aggregate jiffies from the first /proc/stat `cpu` line. */
async function readCpuTimes() {
  try {
    const stat = await readFile('/proc/stat', 'utf8');
    const line = stat.split('\n').find((entry) => entry.startsWith('cpu '));
    if (!line) return null;
    // user nice system idle iowait irq softirq steal guest guest_nice
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    const total = fields.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    return { idle, total };
  } catch {
    return null;
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/**
 * CPU temperature via hwmon.
 *
 * A typical board exposes dozens of sensors; we take the first one whose name
 * looks like a CPU package. Returning null is normal (VMs, containers) and the
 * UI hides the reading rather than showing a fabricated value.
 */
async function readTemperature() {
  const candidates = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal', 'acpitz'];
  try {
    const hwmons = await readdir('/sys/class/hwmon');
    for (const wanted of candidates) {
      for (const dir of hwmons) {
        try {
          const name = (await readFile(`/sys/class/hwmon/${dir}/name`, 'utf8')).trim();
          if (name !== wanted) continue;
          const raw = (await readFile(`/sys/class/hwmon/${dir}/temp1_input`, 'utf8')).trim();
          const milli = Number(raw);
          if (Number.isFinite(milli) && milli > 0) return round(milli / 1000, 1);
        } catch {
          /* sensor without temp1_input — try the next */
        }
      }
    }
  } catch {
    /* no hwmon at all */
  }
  return null;
}

export async function getCpu() {
  const current = await readCpuTimes();
  let usage = 0;

  if (current && previousCpu) {
    const idleDelta = current.idle - previousCpu.idle;
    const totalDelta = current.total - previousCpu.total;
    usage = totalDelta > 0 ? clampPercent((1 - idleDelta / totalDelta) * 100) : 0;
  } else if (current) {
    // First sample: absolute totals are accurate enough for a first paint and
    // become exact on the next tick.
    usage = current.total > 0 ? clampPercent((1 - current.idle / current.total) * 100) : 0;
  }
  if (current) previousCpu = current;

  const info = cpus();
  const load = loadavg();
  const cores = info.length || 1;

  return {
    usage: round(usage, 1),
    load: [round(load[0], 2), round(load[1], 2), round(load[2], 2)],
    loadPercent: round((load[0] / cores) * 100, 1),
    cores,
    model: info[0]?.model?.trim() ?? 'unknown',
    mhz: round(info.reduce((sum, core) => sum + (core.speed || 0), 0) / Math.max(1, info.length), 0),
    temperature: await readTemperature(),
  };
}

/* ------------------------------------------------------------------ */
/* memory                                                              */
/* ------------------------------------------------------------------ */

export async function getMemory() {
  // MemAvailable is the kernel's own estimate of what a new workload could use;
  // "free" alone is misleading because Linux spends spare RAM on page cache.
  const meminfo = await tryRun('cat', ['/proc/meminfo']);
  /** @type {Map<string, number>} */
  const values = new Map();
  if (meminfo) {
    for (const line of meminfo.split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (match) values.set(match[1], Number(match[2]) * 1024);
    }
  }
  const total = values.get('MemTotal') ?? 0;
  const free = values.get('MemFree') ?? 0;
  const buffers = values.get('Buffers') ?? 0;
  const cached = (values.get('Cached') ?? 0) + (values.get('SReclaimable') ?? 0);
  const available = values.get('MemAvailable') ?? free + buffers + cached;
  const used = Math.max(0, total - available);
  const swapTotal = values.get('SwapTotal') ?? 0;
  const swapFree = values.get('SwapFree') ?? 0;

  return {
    total,
    used,
    free,
    available,
    buffers,
    cached,
    swapTotal,
    swapUsed: Math.max(0, swapTotal - swapFree),
    percent: total > 0 ? round((used / total) * 100, 1) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* disks                                                               */
/* ------------------------------------------------------------------ */

export async function getDisks() {
  // statfs() is a syscall: faster and locale-proof compared with parsing `df`,
  // but it needs a path, so mount points come from /proc/mounts.
  const mounts = await tryRun('cat', ['/proc/mounts']);
  if (!mounts) return [];

  const seen = new Set();
  const results = [];

  for (const line of mounts.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [device, mount] = parts;
    // Only real block devices: skips tmpfs, proc, cgroup and overlay layers.
    if (!device.startsWith('/dev/')) continue;
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount)) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);

    try {
      const stats = await statfs(mount);
      const size = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const available = stats.bavail * stats.bsize;
      if (size <= 0) continue;
      results.push({
        filesystem: device,
        size,
        used: size - free,
        available,
        percent: round(((size - free) / size) * 100, 1),
        mount,
      });
    } catch {
      /* unreadable mount (permissions or vanished) — skip */
    }
  }
  return results.sort((a, b) => b.size - a.size);
}

/* ------------------------------------------------------------------ */
/* network                                                             */
/* ------------------------------------------------------------------ */

/** @type {Map<string, { rx: number, tx: number }> | null} */
let previousNet = null;
let previousNetAt = 0;

export async function getNetwork() {
  const dev = await tryRun('cat', ['/proc/net/dev']);
  if (!dev) return [];

  const current = new Map();
  for (const line of dev.split('\n').slice(2)) {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!match) continue;
    const name = match[1].trim();
    if (name === 'lo') continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    current.set(name, { rx: fields[0] ?? 0, tx: fields[8] ?? 0 });
  }

  const now = Date.now();
  const elapsed = previousNetAt ? Math.max(0.2, (now - previousNetAt) / 1000) : 0;
  const result = [];
  for (const [name, counters] of current) {
    const before = previousNet?.get(name);
    result.push({
      name,
      rx: counters.rx,
      tx: counters.tx,
      rxRate: before && elapsed ? Math.max(0, round((counters.rx - before.rx) / elapsed, 0)) : 0,
      txRate: before && elapsed ? Math.max(0, round((counters.tx - before.tx) / elapsed, 0)) : 0,
    });
  }
  previousNet = current;
  previousNetAt = now;
  return result;
}

/* ------------------------------------------------------------------ */
/* host                                                                */
/* ------------------------------------------------------------------ */

async function readDistro() {
  const content = await tryRun('cat', ['/etc/os-release']);
  if (!content) return platform();
  const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return match ? match[1] : platform();
}

async function detectVirtualization() {
  const out = await tryRun('systemd-detect-virt', []);
  if (!out) return null;
  const value = out.trim();
  return value && value !== 'none' ? value : null;
}

/** @type {object | null} */
let cachedHostInfo = null;

export async function getHostInfo() {
  const uptimeSeconds = osUptime();
  if (!cachedHostInfo) {
    cachedHostInfo = {
      hostname: hostname(),
      distro: await readDistro(),
      kernel: release(),
      arch: arch(),
      bootTime: Math.floor(Date.now() / 1000 - uptimeSeconds),
      virtualization: await detectVirtualization(),
    };
  }
  // uptime is dynamic; the rest is static for the process lifetime.
  return { ...cachedHostInfo, uptime: uptimeSeconds };
}

/** Everything the dashboard needs in one round trip. */
export async function getOverview() {
  const [cpu, memory, disks, network, host] = await Promise.all([
    getCpu(),
    getMemory(),
    getDisks(),
    getNetwork(),
    getHostInfo(),
  ]);
  return { cpu, memory, disks, network, host, timestamp: Date.now() };
}
