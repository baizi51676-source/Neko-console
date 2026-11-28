/**
 * Deployment job runner.
 *
 * Deploying is slow (image pulls take minutes) and previously blocked the HTTP
 * request, so the browser showed a spinner with no feedback and long pulls could
 * time out entirely. Jobs now run in the background and stream progress over SSE.
 *
 * Design:
 *   - one job per deployment, keyed by an opaque id
 *   - the log is an append-only array of `{ seq, level, message, at }`; clients
 *     poll/stream from a cursor so a late joiner still sees full history
 *   - jobs are kept in memory with a TTL: a console restart loses in-flight
 *     jobs, which is acceptable because docker keeps running regardless
 *   - finished jobs keep their log for a while so the UI can show the result
 */

import { spawn } from 'node:child_process';

/** How long a finished job stays queryable. */
const RETAIN_MS = 30 * 60 * 1000;
/** Cap per job, to bound memory if a pull is extremely chatty. */
const MAX_LOG_LINES = 2000;

/** @typedef {'queued'|'running'|'succeeded'|'failed'|'cancelled'} JobState */

/**
 * @typedef {object} DeployJob
 * @property {string} id
 * @property {string} name
 * @property {JobState} state
 * @property {number} createdAt
 * @property {number|null} finishedAt
 * @property {{ seq: number, level: string, message: string, at: number }[]} log
 * @property {object|null} result
 * @property {string|null} error
 * @property {string|null} errorCode
 */

/** @type {Map<string, DeployJob>} */
const jobs = new Map();

function makeId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a job and immediately start it.
 *
 * @param {string} name        container/project name, for display
 * @param {(ctx: { log: (message: string, level?: string) => void, isCancelled: () => boolean }) => Promise<object>} run
 * @returns {DeployJob}
 */
export function startJob(name, run) {
  /** @type {DeployJob} */
  const job = {
    id: makeId(),
    name,
    state: 'queued',
    createdAt: Date.now(),
    finishedAt: null,
    log: [],
    result: null,
    error: null,
    errorCode: null,
  };
  jobs.set(job.id, job);

  let cancelled = false;
  const log = (message, level = 'info') => {
    if (job.log.length >= MAX_LOG_LINES) return;
    job.log.push({ seq: job.log.length + 1, level, message, at: Date.now() });
  };

  // Run outside the request lifecycle so the HTTP response can return at once.
  Promise.resolve()
    .then(async () => {
      job.state = 'running';
      log(`开始部署 ${name}`);
      try {
        const result = await run({ log, isCancelled: () => cancelled });
        job.result = result;
        job.state = cancelled ? 'cancelled' : 'succeeded';
        log(cancelled ? '部署已取消' : '部署完成', 'success');
      } catch (error) {
        job.state = 'failed';
        job.error = error?.message ?? String(error);
        job.errorCode = error?.code ?? 'INTERNAL_ERROR';
        log(job.error, 'error');
        if (error?.detail) log(String(error.detail), 'error');
      } finally {
        job.finishedAt = Date.now();
      }
    })
    .catch(() => {});

  job.cancel = () => {
    cancelled = true;
    log('收到取消请求', 'warn');
  };

  return job;
}

/** Snapshot for the client, optionally only entries after `sinceSeq`. */
export function getJob(id, sinceSeq = 0) {
  const job = jobs.get(id);
  if (!job) return null;
  return {
    id: job.id,
    name: job.name,
    state: job.state,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
    errorCode: job.errorCode,
    log: job.log.filter((entry) => entry.seq > sinceSeq),
    lastSeq: job.log.length,
  };
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => ({
      id: job.id,
      name: job.name,
      state: job.state,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      error: job.error,
      errorCode: job.errorCode,
      lines: job.log.length,
    }));
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.state === 'succeeded' || job.state === 'failed') return false;
  job.cancel?.();
  return true;
}

/** Periodic sweep so finished jobs do not accumulate forever. */
export function sweepJobs() {
  const cutoff = Date.now() - RETAIN_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}

/**
 * Run an external process and stream its output into the job log.
 *
 * This is what makes the progress view meaningful: `docker pull` emits layer
 * progress lines, and the user sees them as they happen instead of a spinner.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {(message: string, level?: string) => void} log
 * @param {{ timeout?: number, onLine?: (line: string) => void }} [options]
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export function runStreaming(file, args, log, options = {}) {
  const timeout = options.timeout ?? 900000;

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' },
    });

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      log(`命令超时（${Math.round(timeout / 1000)}s）`, 'error');
      resolve({ ok: false, output });
    }, timeout);
    timer.unref?.();

    /**
     * Docker emits progress with `\r` (carriage return) rather than `\n`, so
     * splitting on newlines alone would buffer an entire layer download before
     * showing anything. Split on both.
     */
    const emit = (chunk) => {
      const text = String(chunk);
      output += text;
      for (const line of text.split(/[\r\n]+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        log(trimmed, 'stream');
        options.onLine?.(trimmed);
      }
    };

    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(error.message, 'error');
      resolve({ ok: false, output: output || error.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}
