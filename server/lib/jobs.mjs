/**
 * Scheduled jobs.
 *
 * Runs from inside Node on a lightweight interval rather than writing to
 * `crontab`. Two reasons:
 *   - the operator can see runs and output in the UI, which crontab cannot offer;
 *   - a job's command never becomes a shell string on disk, so there is no
 *     crontab entry to inject into.
 *
 * Commands are resolved against a **closed set of built-in actions** or a
 * script in a fixed directory. Neither path ever touches a shell: actions are
 * functions, and scripts are executed by path with execFile.
 *
 * Schedules use `every:<seconds>` or a five-field cron expression evaluated by a
 * small in-house matcher (see cron.mjs) — no npm scheduler.
 */
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../errors.mjs';
import { run } from '../util.mjs';
import { audit, getJob, listJobs, now, pruneJobRuns, recordJobRun } from '../db/index.mjs';
import { matchesCron, parseCron } from './cron.mjs';

/** Where operator-provided scripts live. Executed by path, never by shell. */
export const SCRIPT_DIR = process.env.NEKO_JOB_SCRIPTS ?? '/etc/neko-console/jobs';
/** Output is truncated to this many characters before storage. */
const MAX_OUTPUT = 500;

/**
 * The closed set of built-in actions.
 *
 * A `command` of `action.<name>` maps to one of these. Keeping it closed is what
 * makes the feature safe to expose: adding behaviour requires a code change and a
 * restart, not a form submission.
 *
 * @type {Record<string, { description: string, run: (ctx: object) => Promise<string> }>}
 */
export const ACTIONS = {
  'backup.run': {
    description: '执行一次全量备份（数据库 + 站点）',
    run: async () => {
      // Wired at boot by main.mjs to avoid a circular import with the backup lib.
      const { runFullBackup } = globalThis.__nekoBackup ?? {};
      if (!runFullBackup) throw new Error('备份模块未就绪');
      const result = await runFullBackup();
      return `备份完成: ${result.files.length} 个文件，共 ${result.totalSize} 字节`;
    },
  },
  'ssl.renew-check': {
    description: '巡检证书有效期（不触发续期）',
    run: async () => {
      const { certificateHealth } = await import('./certbot.mjs');
      const health = await certificateHealth();
      return `共 ${health.total} 张证书，${health.expiringCount} 张即将到期，${health.expiredCount} 张已过期`;
    },
  },
  'nginx.reload': {
    description: '重载 nginx 配置',
    run: async () => {
      await run('systemctl', ['reload', 'nginx'], { timeout: 30000 });
      return 'nginx 已重载';
    },
  },
  'site.probe': {
    description: '探测所有站点是否可访问',
    run: async () => {
      const { listSites } = await import('../db/index.mjs');
      const sites = listSites();
      const results = [];
      for (const site of sites) {
        const host = String(site.server_names).split(',')[0].trim();
        const out = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8',
          '-H', `Host: ${host}`, 'http://127.0.0.1/'], { timeout: 12000 }).catch(() => '000');
        results.push(`${site.name}=${out.trim()}`);
      }
      return results.join(' ') || '没有配置站点';
    },
  },
};

/**
 * Parse and validate a schedule string.
 *
 * @param {string} schedule
 */
export function validateSchedule(schedule) {
  const value = String(schedule ?? '').trim();
  if (!value) throw new ApiError('VALIDATION_FAILED', '调度表达式不能为空');

  const every = value.match(/^every:(\d{1,6})$/);
  if (every) {
    const seconds = Number(every[1]);
    // Sub-minute intervals would let an operator accidentally fork-bomb the host.
    if (seconds < 60) throw new ApiError('VALIDATION_FAILED', '最小间隔为 60 秒');
    return { kind: 'every', seconds };
  }

  const parsed = parseCron(value);
  if (!parsed) throw new ApiError('VALIDATION_BAD_ACTION', '无法解析的 cron 表达式（需要 5 段：分 时 日 月 周）');
  return { kind: 'cron', cron: parsed };
}

/**
 * Resolve a command string to an executable operation.
 *
 * Returns a function so the caller does not need to branch on `kind` again.
 *
 * @param {string} command
 * @param {string} kind  'auto' | 'actions' | 'script'
 */
export function resolveCommand(command, kind = 'auto') {
  const value = String(command ?? '').trim();
  if (!value) throw new ApiError('VALIDATION_FAILED', '命令不能为空');

  // Built-in action: `action.backup.run` or a bare action name.
  const actionName = value.replace(/^action\./, '');
  if ((kind === 'auto' || kind === 'actions') && ACTIONS[actionName]) {
    const action = ACTIONS[actionName];
    return {
      kind: 'action',
      name: actionName,
      run: async (ctx) => action.run(ctx),
    };
  }
  if (kind === 'actions') {
    throw new ApiError('VALIDATION_BAD_ACTION', `未知的内置动作: ${actionName}`);
  }

  // Script: a bare filename inside SCRIPT_DIR. Rejecting path separators keeps a
  // script from reaching outside the directory.
  if (kind === 'auto' || kind === 'script') {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
      throw new ApiError('VALIDATION_BAD_PATH', '脚本名只能包含字母、数字、点、下划线和短横线（不能包含斜杠）');
    }
    const full = join(SCRIPT_DIR, value);
    return {
      kind: 'script',
      name: value,
      run: async () => {
        if (!existsSync(full)) throw new Error(`脚本不存在: ${full}`);
        // execFile with the script as argv[0]: no shell, so `;`, `|`, `$(...)`
        // inside the filename would be inert (they are already rejected above).
        return await run(full, [], { timeout: 300000, maxBuffer: 1024 * 1024 });
      },
    };
  }

  throw new ApiError('VALIDATION_BAD_ACTION', '未识别的任务类型');
}

/** Scripts available for the picker. */
export async function listScripts() {
  if (!existsSync(SCRIPT_DIR)) return [];
  const entries = await readdir(SCRIPT_DIR).catch(() => []);
  return entries.filter((entry) => /^[A-Za-z0-9._-]+$/.test(entry));
}

/* ------------------------------------------------------------------ */
/* scheduler                                                           */
/* ------------------------------------------------------------------ */

/** @type {Map<number, { lastRun: number }>} */
const runtime = new Map();
let timer = null;

/**
 * Start the scheduler.
 *
 * One interval tick per 10 seconds is enough granularity for minute-level cron
 * and keeps the cost trivial. Each job tracks its own last-run timestamp so a
 * slow job does not cause a burst of catch-up runs.
 */
export function startScheduler({ log = () => {} } = {}) {
  if (timer) return () => {};

  const TICK_MS = 10_000;

  timer = setInterval(async () => {
    let jobs;
    try {
      jobs = listJobs();
    } catch {
      return; // database not ready yet
    }

    for (const job of jobs) {
      if (!job.enabled) continue;
      const state = runtime.get(job.id) ?? { lastRun: 0 };
      const due = isDue(job, state.lastRun);
      if (!due) continue;

      // Mark before running so a long job is not started twice by the next tick.
      state.lastRun = Date.now();
      runtime.set(job.id, state);
      void executeJob(job, log);
    }
  }, TICK_MS);

  timer.unref?.();
  return () => stopScheduler();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Whether a job should run now.
 *
 * @param {object} job
 * @param {number} lastRun epoch ms
 */
function isDue(job, lastRun) {
  const schedule = String(job.schedule ?? '');

  const every = schedule.match(/^every:(\d{1,6})$/);
  if (every) {
    const seconds = Number(every[1]);
    // `- 5000` guard: a one-off interval mismatch must not skip a run entirely.
    return Date.now() - lastRun >= seconds * 1000 - 5000;
  }

  const parsed = parseCron(schedule);
  if (!parsed) return false;

  const current = new Date();
  if (!matchesCron(parsed, current)) return false;

  // Within the matching minute, run at most once.
  return Date.now() - lastRun >= 55_000;
}

/** Run one job immediately, recording the outcome. */
export async function executeJob(job, log = () => {}) {
  const startedAt = now();
  log(`执行任务 ${job.name}`);

  try {
    const operation = resolveCommand(job.command, job.kind);
    const output = await operation.run({ job, log });
    const truncated = String(output ?? '').slice(0, MAX_OUTPUT);
    recordJobRun(job.id, startedAt, 'ok', truncated);
    audit('job.run', job.name, 'ok', `kind=${operation.kind}`);
    log(`任务 ${job.name} 完成`);
    return { ok: true, output: truncated };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, MAX_OUTPUT);
    recordJobRun(job.id, startedAt, 'error', message);
    audit('job.run', job.name, 'error', message.slice(0, 500));
    log(`任务 ${job.name} 失败: ${message}`);
    return { ok: false, error: message };
  } finally {
    pruneJobRuns(5);
  }
}

/** Manually trigger a job from the UI. */
export async function runJobNow(id) {
  const job = getJob(id);
  if (!job) throw new ApiError('NOTFOUND_ROUTE', '任务不存在');
  const state = runtime.get(id) ?? { lastRun: 0 };
  state.lastRun = Date.now();
  runtime.set(id, state);
  return executeJob(job);
}
