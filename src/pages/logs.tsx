// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, FileText, RefreshCw, Search } from 'lucide-react';
import { api, type LogLine } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type Source = 'journal' | 'file';
type Priority = 'all' | 'err' | 'warning' | 'info' | 'debug';

const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'err', label: '错误' },
  { id: 'warning', label: '警告' },
  { id: 'info', label: '信息' },
  { id: 'debug', label: '调试' },
];

/** Rough severity sniff for colour-coding lines that lack a syslog priority. */
function lineSeverity(line: LogLine): 'error' | 'warn' | 'info' {
  const text = line.message.toLowerCase();
  if (/\b(error|fail|fatal|critical|panic|denied|refused|exception)\b/.test(text)) return 'error';
  if (/\b(warn|warning|deprecated|timeout|retry)\b/.test(text)) return 'warn';
  return 'info';
}

export default function LogsPage() {
  const [source, setSource] = useState<Source>('journal');
  const [priority, setPriority] = useState<Priority>('all');
  const [files, setFiles] = useState<{ path: string; size: number; modified: string }[]>([]);
  const [activeFile, setActiveFile] = useState<string>('');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [count, setCount] = useState(300);
  const scroller = useRef<HTMLDivElement>(null);

  const toMessage = useApiError();
  const { notify } = useToast();

  // Discover system log files once; the picker needs them regardless of source.
  useEffect(() => {
    api.logs
      .files()
      .then((result) => {
        setFiles(result.files);
        if (result.files[0]) setActiveFile(result.files[0].path);
      })
      .catch((error) => notify(toMessage(error), 'error'));
  }, [notify, toMessage]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (source === 'journal') {
        const result = await api.logs.journal(count, priority);
        setLines(result.lines);
        if (!result.available) notify('journald 不可用', 'error');
      } else if (activeFile) {
        const result = await api.logs.read(activeFile, count);
        setLines(result.lines);
        if (!result.available) notify('无法读取该日志文件', 'error');
      } else {
        setLines([]);
      }
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [source, priority, activeFile, count, notify, toMessage]);

  useEffect(() => {
    if (source === 'file' && !activeFile) return;
    void load();
    // Auto-refresh only when following, mirroring `tail -f` behaviour.
    const timer = follow ? window.setInterval(() => void load(), 5000) : null;
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [load, follow, source, activeFile]);

  // Keep the newest line visible while following.
  useEffect(() => {
    if (follow && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [lines, follow]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((line) => line.raw.toLowerCase().includes(needle));
  }, [lines, query]);

  const counts = useMemo(() => {
    let error = 0;
    let warn = 0;
    for (const line of lines) {
      const severity = lineSeverity(line);
      if (severity === 'error') error += 1;
      else if (severity === 'warn') warn += 1;
    }
    return { error, warn };
  }, [lines]);

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
        {/* source switch */}
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
          {(
            [
              ['journal', 'journald'],
              ['file', '日志文件'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSource(key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
                source === key ? 'bg-card font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {source === 'journal' ? (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
            {PRIORITIES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPriority(item.id)}
                className={cn(
                  'rounded-md px-2 py-1 text-[11px] transition-colors',
                  priority === item.id
                    ? 'bg-card font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : (
          <select
            value={activeFile}
            onChange={(event) => setActiveFile(event.target.value)}
            aria-label="选择日志文件"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[11.5px] outline-none focus-visible:border-ring"
          >
            {files.length === 0 ? <option value="">（无可用日志文件）</option> : null}
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path} · {formatBytes(file.size)}
              </option>
            ))}
          </select>
        )}

        <span className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="过滤日志内容"
            className="h-8 w-[180px] pl-8 text-[11.5px]"
            aria-label="过滤日志"
          />
        </span>

        <div className="flex-1" />

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {counts.error > 0 ? <Badge tone="destructive">{counts.error} 错误</Badge> : null}
          {counts.warn > 0 ? <Badge tone="warning">{counts.warn} 警告</Badge> : null}
          <span>{filtered.length} 行</span>
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.target.checked)}
            className="size-3.5 accent-[var(--primary)]"
          />
          自动刷新
        </label>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
          }}
          title="跳到最新"
        >
          <ArrowDown className="size-3.5" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-muted/20">
        {loading && lines.length === 0 ? (
          <div className="flex flex-col gap-1.5 p-4">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="sk-shimmer h-3 rounded" style={{ width: `${50 + ((index * 13) % 45)}%` }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={FileText}
              title={lines.length === 0 ? '没有日志内容' : '没有匹配的行'}
              description={lines.length === 0 ? '尝试切换来源或提高日志级别范围。' : '调整过滤关键词试试。'}
            />
          </div>
        ) : (
          <div className="p-3 font-mono text-[11px] leading-[1.65]">
            {filtered.map((line) => {
              const severity = lineSeverity(line);
              return (
                <div
                  key={line.index}
                  className={cn(
                    'flex gap-2 whitespace-pre-wrap break-all rounded px-1 hover:bg-accent/40',
                    severity === 'error' && 'text-destructive',
                    severity === 'warn' && 'text-warning',
                  )}
                >
                  {line.time ? <span className="shrink-0 text-muted-foreground">{line.time}</span> : null}
                  {line.source ? <span className="shrink-0 text-primary">{line.source}</span> : null}
                  <span className="min-w-0">{line.message}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          显示最近 {count} 行 · {source === 'journal' ? 'journald' : activeFile || '未选择文件'}
        </span>
        <div className="flex items-center gap-1">
          {[200, 500, 1000, 2000].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setCount(value)}
              className={cn(
                'rounded px-1.5 py-0.5 transition-colors',
                count === value ? 'bg-accent font-medium text-foreground' : 'hover:bg-accent/60',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
