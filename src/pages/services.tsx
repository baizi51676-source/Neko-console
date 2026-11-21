// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Play, RefreshCw, RotateCcw, ScrollText, Search, Square } from 'lucide-react';
import { api, type LogLine, type ServiceUnit } from '@/lib/api';
import { serviceStateLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type Filter = 'all' | 'running' | 'stopped' | 'failed';

export default function ServicesPage() {
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [logUnit, setLogUnit] = useState<ServiceUnit | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(
    async (refresh = false) => {
      try {
        const result = await api.services.list(refresh);
        setUnits(result.units);
        setAvailable(result.available);
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setLoading(false);
      }
    },
    [notify, toMessage],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return units.filter((unit) => {
      if (needle && !unit.name.toLowerCase().includes(needle) && !unit.description.toLowerCase().includes(needle)) {
        return false;
      }
      switch (filter) {
        case 'running':
          return unit.active === 'active';
        case 'stopped':
          return unit.active === 'inactive';
        case 'failed':
          return unit.active === 'failed';
        default:
          return true;
      }
    });
  }, [units, query, filter]);

  const act = async (unit: ServiceUnit, action: 'start' | 'stop' | 'restart') => {
    setBusy(`${unit.name}:${action}`);
    try {
      await api.services.action(unit.name, action);
      notify(`${unit.name} ${{ start: '已启动', stop: '已停止', restart: '已重启' }[action]}`, 'success');
      // Give systemd a moment to settle before re-reading state.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await load(true);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const openLogs = async (unit: ServiceUnit) => {
    setLogUnit(unit);
    setLogLines([]);
    setLogLoading(true);
    try {
      const result = await api.services.logs(unit.name, 300);
      setLogLines(result.lines);
      if (!result.available) notify('该服务没有可用的 journal 日志', 'error');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLogLoading(false);
    }
  };

  if (!available && !loading) {
    return (
      <Card className="p-4">
        <EmptyState
          title="未检测到 systemd"
          description="该主机可能使用其他 init 系统，或运行在容器中。服务管理功能不可用。"
        />
      </Card>
    );
  }

  const counts = {
    running: units.filter((unit) => unit.active === 'active').length,
    failed: units.filter((unit) => unit.active === 'failed').length,
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
              placeholder="搜索服务名或描述"
              className="w-[240px] pl-8"
              aria-label="搜索服务"
            />
          </span>

          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
            {(
              [
                ['all', `全部 ${units.length}`],
                ['running', `运行中 ${counts.running}`],
                ['stopped', '未运行'],
                ['failed', `失败 ${counts.failed}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  'relative rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
                  filter === key ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {filter === key ? (
                  <motion.span
                    layoutId="svc-filter"
                    className="absolute inset-0 rounded-md bg-card shadow-xs"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                ) : null}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> 刷新
          </Button>
        </div>

        {visible.length === 0 ? (
          <div className="p-4">
            <EmptyState title={loading ? '正在读取服务列表…' : '没有匹配的服务'} />
          </div>
        ) : (
          <div className="max-h-[calc(100dvh-250px)] divide-y divide-border/40 overflow-auto">
            {visible.map((unit) => {
              const state = serviceStateLabel(unit.active, unit.sub);
              const pending = busy?.startsWith(unit.name);
              return (
                <div key={unit.fullName} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-accent/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{unit.name}</span>
                      <Badge tone={state.tone === 'ok' ? 'success' : state.tone === 'danger' ? 'destructive' : state.tone === 'warn' ? 'warning' : 'muted'}>{state.text}</Badge>
                      {unit.load !== 'loaded' ? <Badge tone="warning">未加载</Badge> : null}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{unit.description || '—'}</div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="启动"
                      disabled={pending || unit.active === 'active'}
                      onClick={() => void act(unit, 'start')}
                    >
                      <Play className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="停止"
                      disabled={pending || unit.active === 'inactive'}
                      onClick={() => void act(unit, 'stop')}
                    >
                      <Square className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="重启"
                      disabled={pending}
                      onClick={() => void act(unit, 'restart')}
                    >
                      <RotateCcw className={cn('size-3.5', pending && 'animate-spin')} />
                    </Button>
                    <Button variant="ghost" size="sm" title="查看日志" onClick={() => void openLogs(unit)}>
                      <ScrollText className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Dialog
        open={logUnit !== null}
        onClose={() => setLogUnit(null)}
        title={`${logUnit?.name ?? ''} 日志`}
        description="最近 300 行，来自 journalctl"
        className="max-w-[880px]"
      >
        {logLoading ? (
          <div className="sk-shimmer h-40 rounded-lg" />
        ) : logLines.length === 0 ? (
          <EmptyState title="没有日志" description="该服务可能没有输出，或 journald 不可用。" />
        ) : (
          <pre className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[10.5px] leading-relaxed">
            {logLines.map((line) => (
              <div key={line.index} className="whitespace-pre-wrap break-all">
                {line.raw}
              </div>
            ))}
          </pre>
        )}
      </Dialog>
    </>
  );
}
