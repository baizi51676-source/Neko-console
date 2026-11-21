// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Info, RefreshCw, Search } from 'lucide-react';
import { api, type ProcessRow } from '@/lib/api';
import { formatBytes, formatPercent, processStateLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type SortKey = 'cpu' | 'memory' | 'pid' | 'name';

export default function ProcessesPage() {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('cpu');
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailPid, setDetailPid] = useState<number | null>(null);
  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(async () => {
    try {
      const result = await api.processes.list();
      setRows(result.processes);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, toMessage]);

  // Processes are comparatively expensive to enumerate, so poll slower than the
  // dashboard metrics — 5s is frequent enough to act on and cheap enough to leave
  // running.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.command.toLowerCase().includes(needle) ||
            String(row.pid) === needle,
        )
      : rows;

    return [...filtered].sort((a, b) => {
      switch (sort) {
        case 'memory':
          return b.memory - a.memory;
        case 'pid':
          return a.pid - b.pid;
        case 'name':
          return a.name.localeCompare(b.name);
        default:
          return b.cpu - a.cpu;
      }
    });
  }, [rows, query, sort]);

  const totalCpu = visible.reduce((sum, row) => sum + row.cpu, 0);
  const totalMemory = visible.reduce((sum, row) => sum + row.memory, 0);

  const openDetail = async (pid: number) => {
    setDetailPid(pid);
    setDetail(null);
    try {
      setDetail(await api.processes.detail(pid));
    } catch (error) {
      notify(toMessage(error), 'error');
      setDetailPid(null);
    }
  };

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <span className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索进程名、命令或 PID"
              className="w-[260px] pl-8"
              aria-label="搜索进程"
            />
          </span>

          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
            {(
              [
                ['cpu', 'CPU'],
                ['memory', '内存'],
                ['pid', 'PID'],
                ['name', '名称'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSort(key)}
                className={cn(
                  'relative rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
                  sort === key ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {sort === key ? (
                  <motion.span
                    layoutId="proc-sort"
                    className="absolute inset-0 rounded-md bg-card shadow-xs"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                ) : null}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1" />
          <span className="text-[11.5px] text-muted-foreground">
            {visible.length} 个 · CPU {totalCpu.toFixed(1)}% · 内存 {formatBytes(totalMemory)}
          </span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> 刷新
          </Button>
        </div>

        {visible.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={loading ? '正在读取进程列表…' : '没有匹配的进程'}
              description={loading ? undefined : '换个关键词试试。'}
            />
          </div>
        ) : (
          <div className="max-h-[calc(100dvh-260px)] overflow-auto">
            <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">PID</th>
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 text-right font-medium">CPU</th>
                  <th className="px-4 py-2 text-right font-medium">内存</th>
                  <th className="px-4 py-2 text-right font-medium">线程</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 500).map((row) => (
                  <tr key={row.pid} className="border-b border-border/40 last:border-none hover:bg-accent/40">
                    <td className="px-4 py-1.5 font-mono text-[11.5px] tabular-nums text-muted-foreground">{row.pid}</td>
                    <td className="max-w-[280px] px-4 py-1.5">
                      <div className="truncate font-medium">{row.name}</div>
                      <div className="truncate text-[10.5px] text-muted-foreground">{row.command}</div>
                    </td>
                    <td className="px-4 py-1.5">
                      <Badge tone={row.state === 'R' ? 'success' : row.state === 'Z' ? 'destructive' : 'muted'}>
                        {processStateLabel(row.state)}
                      </Badge>
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{row.cpu.toFixed(1)}%</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">
                      {formatBytes(row.memory)}
                      <span className="ml-1 text-[10.5px] text-muted-foreground">{formatPercent(row.memoryPercent)}</span>
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{row.threads}</td>
                    <td className="px-4 py-1.5 text-right">
                      <Button variant="ghost" size="sm" onClick={() => void openDetail(row.pid)} aria-label={`查看 ${row.name} 详情`}>
                        <Info className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length > 500 ? (
              <div className="border-t border-border/60 px-4 py-2 text-center text-[11px] text-muted-foreground">
                仅显示前 500 个，请用搜索缩小范围。
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Dialog
        open={detailPid !== null}
        onClose={() => setDetailPid(null)}
        title={`进程 ${detailPid ?? ''}`}
        description="来自 /proc 的实时信息"
      >
        {detail === null ? (
          <div className="flex flex-col gap-2">
            <div className="sk-shimmer h-3 w-40 rounded" />
            <div className="sk-shimmer h-3 w-56 rounded" />
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-[12px]">
            <Field label="命令" value={String(detail.command ?? '—')} mono />
            <Field label="可执行文件" value={String(detail.exe ?? '（无权限读取）')} mono />
            <Field label="工作目录" value={String(detail.cwd ?? '（无权限读取）')} mono />
            <div className="grid grid-cols-2 gap-2">
              <Field label="状态" value={String(detail.state ?? '—')} />
              <Field label="线程" value={String(detail.threads ?? '—')} />
              <Field label="常驻内存" value={formatBytes(Number(detail.vmRss ?? 0))} />
              <Field label="虚拟内存" value={formatBytes(Number(detail.vmSize ?? 0))} />
            </div>
            {Array.isArray(detail.env) && detail.env.length > 0 ? (
              <div>
                <div className="mb-1 text-[11.5px] font-medium text-foreground/85">
                  环境变量（敏感值已打码）
                </div>
                <div className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10.5px] leading-relaxed">
                  {(detail.env as { key: string; value: string }[]).map((entry) => (
                    <div key={entry.key} className="truncate">
                      <span className="text-primary">{entry.key}</span>
                      <span className="text-muted-foreground">={entry.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Dialog>
    </>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('break-all rounded-md bg-muted/40 px-2 py-1.5', mono && 'font-mono text-[11px]')}>{value}</div>
    </div>
  );
}
