// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { dockerApi, type DeployJob, type DeployJobSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-muted-foreground',
  stream: 'text-foreground/70',
  success: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
};

const STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '部署中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * Live deployment log.
 *
 * Polls the job endpoint with a cursor (`since`) instead of refetching the whole
 * log, so a 2000-line pull log stays cheap. Polling rather than SSE because the
 * existing SSE stream is a single global metrics channel; a per-job stream would
 * need its own endpoint and lifecycle for no practical gain at this cadence.
 */
export function DeployLog({ jobId, onDone }: { jobId: string; onDone?: (job: DeployJob) => void }) {
  const [job, setJob] = useState<DeployJob | null>(null);
  const [lines, setLines] = useState<DeployJob['log']>([]);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    cursor.current = 0;
    setLines([]);
    setJob(null);
    setError(null);
    finished.current = false;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await dockerApi.job(jobId, cursor.current);
        if (cancelled) return;
        setJob(next);
        if (next.log.length > 0) {
          cursor.current = next.lastSeq;
          setLines((current) => [...current, ...next.log]);
        }
        if (next.state === 'succeeded' || next.state === 'failed' || next.state === 'cancelled') {
          if (!finished.current) {
            finished.current = true;
            onDone?.(next);
          }
          return; // stop polling
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '无法获取部署状态');
        return;
      }
      timer = window.setTimeout(tick, 900);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, onDone]);

  // Follow the tail so new output stays visible during a long pull.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines]);

  const state = job?.state ?? 'queued';
  const isDone = state === 'succeeded' || state === 'failed' || state === 'cancelled';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'grid size-6 place-items-center rounded-full',
            state === 'succeeded'
              ? 'bg-success/15 text-success'
              : state === 'failed'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-[var(--accent-soft)] text-primary',
          )}
        >
          {state === 'succeeded' ? (
            <Check className="size-3.5" />
          ) : state === 'failed' ? (
            <X className="size-3.5" />
          ) : (
            <Loader2 className="size-3.5 animate-spin" />
          )}
        </span>
        <span className="text-[12.5px] font-medium">{job?.name ?? '部署'}</span>
        <span className="text-[11px] text-muted-foreground">{STATE_LABEL[state] ?? state}</span>
        {!isDone ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => void dockerApi.cancelJob(jobId).catch(() => {})}
          >
            取消
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <div
        ref={scroller}
        className="max-h-[46vh] min-h-[160px] overflow-auto rounded-lg border border-border bg-muted/30 p-2.5 font-mono text-[10.5px] leading-[1.7]"
      >
        {lines.length === 0 ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> 正在启动部署任务…
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.seq} className={cn('whitespace-pre-wrap break-all', LEVEL_STYLE[line.level] ?? '')}>
              {line.message}
            </div>
          ))
        )}
      </div>

      {job?.result ? (
        <div className="rounded-lg border border-success/30 bg-success/8 px-3 py-2 text-[11.5px]">
          部署成功
          {job.result.command ? (
            <code className="mt-1 block truncate font-mono text-[10.5px] text-muted-foreground">{job.result.command}</code>
          ) : null}
          {job.result.file ? (
            <code className="mt-1 block truncate font-mono text-[10.5px] text-muted-foreground">{job.result.file}</code>
          ) : null}
        </div>
      ) : null}

      {job?.error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
          {job.error}
          {job.errorCode ? <span className="ml-1 opacity-70">({job.errorCode})</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact list of recent deployments, shown above the catalogue so a user can
 * see that a background job is still running after navigating away.
 */
export function DeployJobsBanner({ onOpen }: { onOpen: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<DeployJobSummary[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const result = await dockerApi.jobs();
        if (alive) setJobs(result.jobs.filter((job) => job.state === 'running' || job.state === 'queued').slice(0, 3));
      } catch {
        /* the banner is informational; failures are not worth surfacing */
      }
    };
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <AnimatePresence>
      {jobs.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2 text-[11.5px]"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          <span className="font-medium">正在部署</span>
          {jobs.map((job) => (
            <button key={job.id} type="button" onClick={() => onOpen(job.id)} className="text-primary underline-offset-4 hover:underline">
              {job.name}
            </button>
          ))}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
