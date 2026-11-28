// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, Loader2, Play, Plus, RefreshCw, Terminal, Trash2, X } from 'lucide-react';
import { panelApi, type JobRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, PageHeader } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

/** Human-readable form of the `every:<n>` / cron schedule. */
function describeSchedule(schedule: string): string {
  const every = schedule.match(/^every:(\d+)$/);
  if (every) {
    const seconds = Number(every[1]);
    if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
    if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
    return `每 ${seconds} 秒`;
  }
  const parts = schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    if (parts[0].startsWith('*/') && parts.slice(1).every((p) => p === '*')) {
      return `每 ${parts[0].slice(2)} 分钟`;
    }
    if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      return `每天 ${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
    }
  }
  return schedule;
}

const PRESETS = [
  { label: '每 5 分钟', value: '*/5 * * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每天 03:00', value: '0 3 * * *' },
  { label: '每周一 04:00', value: '0 4 * * 1' },
];

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [actions, setActions] = useState<{ name: string; description: string }[]>([]);
  const [scripts, setScripts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [editing, setEditing] = useState<JobRow | 'new' | null>(null);
  const [draft, setDraft] = useState({ name: '', schedule: '0 3 * * *', command: '', kind: 'auto' as 'auto' | 'actions' | 'script' });
  const [deleting, setDeleting] = useState<JobRow | null>(null);

  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(async () => {
    try {
      const result = await panelApi.jobs();
      setJobs(result.jobs);
      setActions(result.actions);
      setScripts(result.scripts);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, toMessage]);

  useEffect(() => {
    void load();
    // The scheduler writes results in the background, so refresh periodically.
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openEditor = (job: JobRow | 'new') => {
    setEditing(job);
    if (job === 'new') {
      setDraft({ name: '', schedule: '0 3 * * *', command: actions[0]?.name ? `action.${actions[0].name}` : '', kind: 'actions' });
    } else {
      setDraft({
        name: job.name,
        schedule: job.schedule,
        command: job.command,
        kind: (job.kind as 'auto' | 'actions' | 'script') ?? 'auto',
      });
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      if (editing === 'new') {
        await panelApi.createJob(draft);
        notify('任务已创建', 'success');
      } else if (editing) {
        await panelApi.updateJob({ ...draft, id: editing.id });
        notify('任务已更新', 'success');
      }
      setEditing(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (job: JobRow) => {
    setBusy(`run-${job.id}`);
    try {
      const result = await panelApi.runJob(job.id);
      notify(result.ok ? `执行完成：${result.output ?? ''}` : `执行失败：${result.error ?? ''}`, result.ok ? 'success' : 'error');
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (job: JobRow) => {
    try {
      await panelApi.updateJob({ id: job.id, enabled: !job.enabled });
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy('delete');
    try {
      await panelApi.deleteJob(deleting.id);
      notify('任务已删除', 'success');
      setDeleting(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1].map((index) => (
          <div key={index} className="sk-shimmer h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="计划任务"
        description="定时执行内置动作或白名单脚本。不使用 crontab，执行记录保存在面板内。"
        actions={
          <>
            <Button variant="outline" onClick={() => void load()}>
              <RefreshCw className="size-3.5" /> 刷新
            </Button>
            <Button onClick={() => openEditor('new')}>
              <Plus className="size-3.5" /> 新建任务
            </Button>
          </>
        }
      />

      {jobs.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="还没有计划任务"
          description="可以定时执行备份、证书巡检、nginx 重载等内置动作。"
          action={
            <Button onClick={() => openEditor('new')}>
              <Plus className="size-3.5" /> 新建任务
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {jobs.map((job) => {
            const lastRun = job.runs?.[0];
            return (
              <Card key={job.id} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-lg',
                      job.enabled ? 'bg-[var(--accent-soft)] text-primary' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Clock className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-medium">{job.name}</span>
                      <Badge tone={job.enabled ? 'success' : 'muted'}>{job.enabled ? '已启用' : '已暂停'}</Badge>
                      <Badge tone="muted">{describeSchedule(job.schedule)}</Badge>
                      {lastRun ? (
                        <Badge tone={lastRun.status === 'ok' ? 'success' : 'destructive'}>
                          {lastRun.status === 'ok' ? (
                            <Check className="mr-0.5 inline size-2.5" />
                          ) : (
                            <X className="mr-0.5 inline size-2.5" />
                          )}
                          上次{lastRun.status === 'ok' ? '成功' : '失败'}
                        </Badge>
                      ) : null}
                    </div>
                    <code className="mt-0.5 block truncate font-mono text-[10.5px] text-muted-foreground">{job.command}</code>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === `run-${job.id}`}
                      onClick={() => void runNow(job)}
                      aria-label="立即执行"
                    >
                      {busy === `run-${job.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void toggle(job)}>
                      {job.enabled ? '暂停' : '启用'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEditor(job)}>
                      编辑
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(job)} aria-label="删除任务">
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>

                {lastRun?.output ? (
                  <pre className="mt-2 max-h-20 overflow-auto rounded-md border border-border bg-muted/40 p-1.5 font-mono text-[10px] text-muted-foreground">
                    {lastRun.output}
                  </pre>
                ) : null}
                {lastRun ? (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    上次执行 {new Date(lastRun.started_at).toLocaleString('zh-CN')}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          命令字段不允许 shell 字符串：只能选择内置动作，或填入 <code className="font-mono">/etc/neko-console/jobs</code> 下的脚本名。
          两类都通过 execFile 直接执行，不经过 shell，因此 <code className="font-mono">;</code>、
          <code className="font-mono">|</code>、<code className="font-mono">$(...)</code> 都无法使用。
        </span>
      </div>

      {/* editor */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '新建任务' : `编辑任务 ${editing?.name ?? ''}`}
        className="max-w-[560px]"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button disabled={busy === 'save' || !draft.name || !draft.command} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="任务名">
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="每日备份"
            />
          </Field>

          <Field label="调度" hint="5 段 cron 表达式，或 every:秒数（最小 60）">
            <Input
              value={draft.schedule}
              onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
              placeholder="0 3 * * *"
              className="font-mono"
            />
          </Field>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => setDraft({ ...draft, schedule: preset.value })}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[10.5px] transition-colors',
                  draft.schedule === preset.value
                    ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-foreground/85">动作类型</div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['actions', '内置动作', '从预定义列表选择', Check],
                  ['script', '脚本', '执行白名单目录下的脚本', Terminal],
                ] as const
              ).map(([value, label, hint, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDraft({ ...draft, kind: value, command: value === 'actions' ? `action.${actions[0]?.name ?? ''}` : '' })}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors',
                    draft.kind === value ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]' : 'border-border hover:bg-accent/50',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    <Icon className="size-3.5" /> {label}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {draft.kind === 'actions' ? (
            <Field label="内置动作">
              <select
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
              >
                {actions.map((action) => (
                  <option key={action.name} value={`action.${action.name}`}>
                    {action.name} — {action.description}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field
              label="脚本名"
              hint={scripts.length > 0 ? `可用: ${scripts.join(', ')}` : '/etc/neko-console/jobs 下暂无可执行脚本'}
            >
              <Input
                value={draft.command}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                placeholder="backup.sh"
                className="font-mono"
              />
            </Field>
          )}
        </div>
      </Dialog>

      {/* delete */}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除任务 ${deleting?.name ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy === 'delete'} onClick={() => void remove()}>
              {busy === 'delete' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-muted-foreground">删除后该任务不再执行，历史执行记录一并清除。</p>
      </Dialog>
    </>
  );
}
