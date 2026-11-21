// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Cpu, HardDrive, MemoryStick, Network, Server, Thermometer, Timer, Zap } from 'lucide-react';
import { subscribeMetrics, type Overview } from '@/lib/api';
import { formatBytes, formatPercent, formatRate, formatUptime, metricTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

/**
 * Live overview.
 *
 * Metrics arrive over SSE every 2s. The chart keeps a fixed-length ring buffer
 * (60 samples ≈ 2 minutes) rather than unbounded history: a console tab left open
 * for a day must not grow the heap.
 */

const HISTORY = 60;

interface Sample {
  at: number;
  cpu: number;
  memory: number;
  rx: number;
  tx: number;
}

export default function DashboardPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [connected, setConnected] = useState(false);
  const toMessage = useApiError();
  const { notify } = useToast();
  const warned = useRef(false);

  useEffect(() => {
    const unsubscribe = subscribeMetrics(
      (data) => {
        setOverview(data);
        setConnected(true);
        warned.current = false;
        const rx = data.network.reduce((sum, iface) => sum + iface.rxRate, 0);
        const tx = data.network.reduce((sum, iface) => sum + iface.txRate, 0);
        setHistory((current) => {
          const next = [...current, { at: data.timestamp, cpu: data.cpu.usage, memory: data.memory.percent, rx, tx }];
          return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
        });
      },
      () => {
        setConnected(false);
        // EventSource reconnects on its own; only complain once per outage.
        if (!warned.current) {
          warned.current = true;
          notify('实时连接中断，正在重连…', 'error');
        }
      },
    );
    return unsubscribe;
  }, [notify, toMessage]);

  if (!overview) {
    return (
      <div className="grid gap-3">
        <div className="sk-shimmer h-28 rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="sk-shimmer h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const { cpu, memory, disks, network, host } = overview;
  const totalRx = network.reduce((sum, iface) => sum + iface.rxRate, 0);
  const totalTx = network.reduce((sum, iface) => sum + iface.txRate, 0);

  /*
   * Pick the disk that matters for the headline KPI.
   *
   * Snap packages mount their squashfs images as loop devices under /snap/*,
   * and those always read 100% used because the image is exactly its own size.
   * Ranking by "fullest" without filtering them out made the dashboard show a
   * permanent red 100% warning while the real root filesystem sat at 40%.
   *
   * So: drop loopback/squashfs mounts, then take the *most used* remaining disk
   * (a full data volume is more urgent than the largest healthy one).
   */
  const realDisks = disks.filter((disk) => !/^\/(snap|var\/lib\/snapd)\b/.test(disk.mount));
  const headlineDisk = realDisks.reduce(
    (worst, disk) => (disk.percent > (worst?.percent ?? -1) ? disk : worst),
    realDisks[0],
  );

  return (
    <>
      {/* ---------- host identity ---------- */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-primary">
              <Server className="size-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold tracking-tight">{host.hostname}</span>
                <Badge tone={connected ? 'success' : 'muted'}>{connected ? '实时' : '已断开'}</Badge>
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                {host.distro} · {host.arch}
                {host.virtualization ? ` · ${host.virtualization}` : ''}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Timer className="size-3.5" /> 运行 {formatUptime(host.uptime)}
            </span>
            <span className="flex items-center gap-1.5">
              <Cpu className="size-3.5" /> 内核 {host.kernel}
            </span>
            {cpu.temperature !== null ? (
              <span className={cn('flex items-center gap-1.5', cpu.temperature >= 80 && 'text-destructive')}>
                <Thermometer className="size-3.5" /> {cpu.temperature}°C
              </span>
            ) : null}
          </div>
        </div>
      </Card>

      {/* ---------- KPI row ---------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Cpu}
          label="CPU"
          value={formatPercent(cpu.usage)}
          percent={cpu.usage}
          detail={`${cpu.cores} 核 · ${cpu.mhz} MHz`}
        />
        <MetricCard
          icon={MemoryStick}
          label="内存"
          value={formatPercent(memory.percent)}
          percent={memory.percent}
          detail={`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`}
        />
        <MetricCard
          icon={HardDrive}
          label="磁盘"
          value={headlineDisk ? formatPercent(headlineDisk.percent) : '—'}
          percent={headlineDisk?.percent ?? 0}
          detail={headlineDisk ? `${formatBytes(headlineDisk.used)} / ${formatBytes(headlineDisk.size)}` : '无数据'}
        />
        <MetricCard
          icon={Zap}
          label="负载"
          value={cpu.load[0].toFixed(2)}
          percent={cpu.loadPercent}
          detail={`1m / 5m / 15m · ${cpu.load.join(' / ')}`}
        />
      </div>

      {/* ---------- charts ---------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="CPU 与内存" subtitle="最近 2 分钟" history={history} />
        <ChartCard title="网络吞吐" subtitle={`↓ ${formatRate(totalRx)} · ↑ ${formatRate(totalTx)}`} history={history} network />
      </div>

      {/* ---------- detail ---------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <HardDrive className="size-3.5 text-primary" /> 磁盘使用
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {realDisks.length === 0 ? (
              <EmptyState title="没有可显示的磁盘" description="未检测到块设备挂载点。" />
            ) : (
              realDisks.map((disk) => (
                <div key={disk.mount}>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="truncate font-medium">{disk.mount}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatBytes(disk.used)} / {formatBytes(disk.size)}
                    </span>
                  </div>
                  <Bar percent={disk.percent} />
                  <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground">
                    <span className="truncate">{disk.filesystem}</span>
                    <span>剩余 {formatBytes(disk.available)}</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Network className="size-3.5 text-primary" /> 网络接口
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {network.length === 0 ? (
              <EmptyState title="没有可显示的网络接口" description="未在 /proc/net/dev 中找到非回环接口。" />
            ) : (
              network.map((iface) => (
                <div
                  key={iface.name}
                  className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-[12px]"
                >
                  <span className="font-medium">{iface.name}</span>
                  <span className="flex gap-4 tabular-nums text-muted-foreground">
                    <span>↓ {formatRate(iface.rxRate)}</span>
                    <span>↑ {formatRate(iface.txRate)}</span>
                    <span className="text-[10.5px]">累计 {formatBytes(iface.rx + iface.tx)}</span>
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- swap warning ---------- */}
      {memory.swapTotal > 0 && memory.swapUsed / memory.swapTotal > 0.5 ? (
        <Card className="border-warning/40 p-3">
          <div className="flex items-center gap-2 text-[12px] text-warning">
            <AlertTriangle className="size-4 shrink-0" />
            交换分区使用率已达 {formatPercent((memory.swapUsed / memory.swapTotal) * 100)}，内存可能不足。
          </div>
        </Card>
      ) : null}
    </>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  percent,
  detail,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  percent: number;
  detail: string;
}) {
  const tone = metricTone(percent);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight">{value}</div>
        </div>
        <span
          className={cn(
            'grid size-8 place-items-center rounded-lg',
            tone === 'danger'
              ? 'bg-destructive/12 text-destructive'
              : tone === 'warn'
                ? 'bg-warning/15 text-warning'
                : 'bg-[var(--accent-soft)] text-primary',
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
      <Bar percent={percent} tone={tone} className="mt-3" />
      <div className="mt-1.5 truncate text-[11px] text-muted-foreground">{detail}</div>
    </Card>
  );
}

function Bar({ percent, tone, className }: { percent: number; tone?: 'ok' | 'warn' | 'danger'; className?: string }) {
  const resolved = tone ?? metricTone(percent);
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}>
      <motion.div
        className={cn(
          'h-full rounded-full',
          resolved === 'danger' ? 'bg-destructive' : resolved === 'warn' ? 'bg-warning' : 'bg-primary',
        )}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      />
    </div>
  );
}

/**
 * Sparkline-style chart drawn as plain SVG.
 *
 * No charting dependency: two polylines and a gradient fill cover what a server
 * console needs, and they stay crisp at any size.
 */
function ChartCard({
  title,
  subtitle,
  history,
  network = false,
}: {
  title: string;
  subtitle: string;
  history: Sample[];
  network?: boolean;
}) {
  const series = useMemo(() => {
    if (network) {
      const peak = Math.max(1, ...history.map((sample) => Math.max(sample.rx, sample.tx)));
      return {
        a: history.map((sample) => (sample.rx / peak) * 100),
        b: history.map((sample) => (sample.tx / peak) * 100),
        labels: ['接收', '发送'],
      };
    }
    return {
      a: history.map((sample) => sample.cpu),
      b: history.map((sample) => sample.memory),
      labels: ['CPU', '内存'],
    };
  }, [history, network]);

  const toPoints = (values: number[]) => {
    if (values.length === 0) return '';
    return values
      .map((value, index) => {
        const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
        const y = 100 - Math.min(100, Math.max(0, value));
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          <span className="text-[11px] text-muted-foreground">{subtitle}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative h-32 w-full">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible">
            {/* horizontal guides at 25/50/75% */}
            {[25, 50, 75].map((line) => (
              <line
                key={line}
                x1="0"
                x2="100"
                y1={line}
                y2={line}
                stroke="var(--border)"
                strokeWidth="0.4"
                strokeDasharray="2 2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              points={toPoints(series.a)}
              fill="none"
              stroke="var(--primary)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={toPoints(series.b)}
              fill="none"
              stroke="var(--warning)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary" /> {series.labels[0]}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" /> {series.labels[1]}
          </span>
          {history.length > 0 ? (
            <span className="ml-auto tabular-nums">
              {network
                ? `峰值 ${formatBytes(Math.max(...history.map((s) => Math.max(s.rx, s.tx))))}/s`
                : `当前 ${history[history.length - 1].cpu.toFixed(0)}% / ${history[history.length - 1].memory.toFixed(0)}%`}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
