// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  Box,
  Boxes,
  Info,
  Layers,
  Network,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Square,
  Trash2,
} from 'lucide-react';
import { dockerApi, type Container, type DockerStatus } from '@/lib/api';
import { formatBytes, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type Tab = 'containers' | 'stacks' | 'images' | 'volumes' | 'networks';

export default function DockerPage() {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('containers');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const [logTarget, setLogTarget] = useState<Container | null>(null);
  const [logLines, setLogLines] = useState<{ index: number; raw: string }[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [detail, setDetail] = useState<Container | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Container | null>(null);

  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(async () => {
    try {
      setStatus(await dockerApi.status());
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, toMessage]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (container: Container, action: 'start' | 'stop' | 'restart') => {
    setBusy(`${container.name}:${action}`);
    try {
      await dockerApi.action(container.name, action);
      notify(`${container.name} ${{ start: '已启动', stop: '已停止', restart: '已重启' }[action]}`, 'success');
      await new Promise((resolve) => setTimeout(resolve, 700));
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const confirmRemove = async () => {
    if (!deleteTarget) return;
    setBusy(`rm:${deleteTarget.name}`);
    try {
      await dockerApi.remove(deleteTarget.name, true);
      notify(`已删除 ${deleteTarget.name}`, 'success');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const openLogs = async (container: Container) => {
    setLogTarget(container);
    setLogLines([]);
    setLogLoading(true);
    try {
      const result = await dockerApi.logs(container.name, 400);
      setLogLines(result.lines);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLogLoading(false);
    }
  };

  const filteredContainers = useMemo(() => {
    if (!status) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return status.containers;
    return status.containers.filter(
      (container) =>
        container.name.toLowerCase().includes(needle) ||
        container.image.toLowerCase().includes(needle) ||
        (container.composeProject ?? '').toLowerCase().includes(needle),
    );
  }, [status, query]);

  if (loading) {
    return (
      <div className="grid gap-3">
        <div className="sk-shimmer h-20 rounded-xl" />
        <div className="sk-shimmer h-64 rounded-xl" />
      </div>
    );
  }

  if (!status?.available) {
    return (
      <Card className="p-4">
        <EmptyState
          icon={Box}
          title="Docker 不可用"
          description={status?.reason ?? '无法连接到 Docker 守护进程'}
          action={
            <div className="flex flex-col gap-2 text-left text-[11.5px] text-muted-foreground">
              <p>若提示权限不足，把运行服务的用户加入 docker 组：</p>
              <code className="rounded bg-muted px-2 py-1 font-mono">sudo usermod -aG docker neko</code>
              <code className="rounded bg-muted px-2 py-1 font-mono">sudo systemctl restart neko-console</code>
            </div>
          }
        />
      </Card>
    );
  }

  const running = status.containers.filter((container) => container.state === 'running').length;

  return (
    <>
      {/* summary */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-primary">
              <Boxes className="size-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold tracking-tight">Docker</span>
                <Badge tone="success">{status.version}</Badge>
                {status.compose ? <Badge tone="muted">compose {status.compose}</Badge> : null}
              </div>
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                {running}/{status.containers.length} 个容器运行中 · {status.stacks.length} 个 Compose 项目
              </div>
            </div>
          </div>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> 刷新
          </Button>
        </div>
      </Card>

      {/* tabs */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
            {(
              [
                ['containers', `容器 ${status.containers.length}`],
                ['stacks', `项目 ${status.stacks.length}`],
                ['images', `镜像 ${status.images.length}`],
                ['volumes', `卷 ${status.volumes.length}`],
                ['networks', `网络 ${status.networks.length}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  'relative rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
                  tab === key ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab === key ? (
                  <motion.span
                    layoutId="docker-tab"
                    className="absolute inset-0 rounded-md bg-card shadow-xs"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                ) : null}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
          {tab === 'containers' ? (
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索容器 / 镜像 / 项目"
              className="h-8 w-[240px] text-[11.5px]"
              aria-label="搜索容器"
            />
          ) : null}
        </div>

        {tab === 'containers' ? (
          <div className="max-h-[calc(100dvh-300px)] divide-y divide-border/40 overflow-auto">
            {filteredContainers.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={Box} title="没有容器" description="在「一键安装」里部署第一个应用。" />
              </div>
            ) : (
              filteredContainers.map((container) => {
                const isRunning = container.state === 'running';
                const pending = busy?.startsWith(container.name);
                return (
                  <div key={container.id} className="px-4 py-2.5 hover:bg-accent/30">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          isRunning ? 'bg-success' : container.state === 'exited' ? 'bg-muted-foreground/50' : 'bg-warning',
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => setDetail(container)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium">{container.name}</span>
                          <Badge tone={isRunning ? 'success' : 'muted'}>{container.state}</Badge>
                          {container.health ? <Badge tone={container.health === 'healthy' ? 'success' : 'warning'}>{container.health}</Badge> : null}
                          {container.composeProject ? <Badge tone="accent">{container.composeProject}</Badge> : null}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {container.image} · {container.runningFor}
                          {container.ports ? ` · ${container.ports}` : ''}
                        </div>
                      </button>

                      {container.stats && isRunning ? (
                        <div className="hidden shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground sm:flex">
                          <span>CPU {formatPercent(container.stats.cpu)}</span>
                          <span>{formatBytes(container.stats.memory)}</span>
                          <span>{container.stats.pids} 进程</span>
                        </div>
                      ) : null}

                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          title={isRunning ? '停止' : '启动'}
                          disabled={pending}
                          onClick={() => void act(container, isRunning ? 'stop' : 'start')}
                        >
                          {isRunning ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="重启"
                          disabled={pending || !isRunning}
                          onClick={() => void act(container, 'restart')}
                        >
                          <RotateCcw className={cn('size-3.5', pending && 'animate-spin')} />
                        </Button>
                        <Button variant="ghost" size="sm" title="日志" onClick={() => void openLogs(container)}>
                          <ScrollText className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" title="详情" onClick={() => setDetail(container)}>
                          <Info className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" title="删除" onClick={() => setDeleteTarget(container)}>
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : null}

        {tab === 'stacks' ? (
          <div className="divide-y divide-border/40">
            {status.stacks.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={Layers} title="没有 Compose 项目" />
              </div>
            ) : (
              status.stacks.map((stack) => (
                <div key={stack.name} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Layers className="size-3.5 shrink-0 text-primary" />
                    <span className="text-[13px] font-medium">{stack.name}</span>
                    <Badge tone={stack.running === stack.total ? 'success' : 'warning'}>
                      {stack.running}/{stack.total}
                    </Badge>
                    <div className="flex-1" />
                    <span className="truncate text-[10.5px] text-muted-foreground">{stack.configFile ?? '—'}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {stack.services.map((service) => (
                      <span
                        key={service.container}
                        className="rounded border border-border/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                      >
                        {service.name} · {service.state}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {tab === 'images' ? (
          <div className="max-h-[calc(100dvh-300px)] overflow-auto">
            <table className="w-full min-w-[600px] text-[12px]">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">仓库</th>
                  <th className="px-4 py-2 font-medium">标签</th>
                  <th className="px-4 py-2 text-right font-medium">大小</th>
                  <th className="px-4 py-2 text-right font-medium">创建</th>
                </tr>
              </thead>
              <tbody>
                {status.images.map((image) => (
                  <tr key={`${image.id}-${image.tag}`} className="border-b border-border/40 last:border-none">
                    <td className="px-4 py-1.5 font-mono text-[11px]">{image.repository}</td>
                    <td className="px-4 py-1.5">{image.tag}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">{image.size}</td>
                    <td className="px-4 py-1.5 text-right text-muted-foreground">{image.createdSince}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'volumes' ? (
          <div className="divide-y divide-border/40">
            {status.volumes.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={Layers} title="没有数据卷" description="容器未使用命名卷。" />
              </div>
            ) : (
              status.volumes.map((volume) => (
                <div key={volume.name} className="flex items-center gap-3 px-4 py-2">
                  <span className="text-[12.5px] font-medium">{volume.name}</span>
                  <Badge tone="muted">{volume.driver}</Badge>
                  <span className="truncate text-[10.5px] text-muted-foreground">{volume.mountpoint}</span>
                </div>
              ))
            )}
          </div>
        ) : null}

        {tab === 'networks' ? (
          <div className="divide-y divide-border/40">
            {status.networks.map((network) => (
              <div key={network.id} className="flex items-center gap-3 px-4 py-2">
                <Network className="size-3.5 text-primary" />
                <span className="text-[12.5px] font-medium">{network.name}</span>
                <Badge tone="muted">{network.driver}</Badge>
                <Badge tone="muted">{network.scope}</Badge>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* logs dialog */}
      <Dialog
        open={logTarget !== null}
        onClose={() => setLogTarget(null)}
        title={`${logTarget?.name ?? ''} 日志`}
        description="最近 400 行"
        className="max-w-[900px]"
      >
        {logLoading ? (
          <div className="sk-shimmer h-48 rounded-lg" />
        ) : logLines.length === 0 ? (
          <EmptyState title="没有日志输出" />
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

      {/* detail dialog */}
      <Dialog
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail?.name ?? ''}
        description={detail?.image}
        className="max-w-[680px]"
      >
        {detail ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="grid grid-cols-2 gap-2">
              <Field label="状态" value={`${detail.state}${detail.health ? ` (${detail.health})` : ''}`} />
              <Field label="重启策略" value={detail.restartPolicy ?? '—'} />
              <Field label="运行时长" value={detail.runningFor} />
              <Field label="容器 ID" value={detail.id.slice(0, 12)} mono />
            </div>

            {detail.portsDetailed && detail.portsDetailed.length > 0 ? (
              <div>
                <div className="mb-1 text-[11px] font-medium text-foreground/85">端口映射</div>
                <div className="flex flex-wrap gap-1.5">
                  {detail.portsDetailed.map((port) => (
                    <code key={`${port.hostPort}-${port.containerPort}`} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">
                      {port.hostPort ? `${port.hostIp || '0.0.0.0'}:${port.hostPort} → ` : ''}
                      {port.containerPort}/{port.protocol}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {detail.mounts && detail.mounts.length > 0 ? (
              <div>
                <div className="mb-1 text-[11px] font-medium text-foreground/85">挂载</div>
                <div className="flex flex-col gap-1">
                  {detail.mounts.map((mount) => (
                    <code key={mount.destination} className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">
                      {mount.source} → {mount.destination} ({mount.mode})
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {detail.env && detail.env.length > 0 ? (
              <div>
                <div className="mb-1 text-[11px] font-medium text-foreground/85">环境变量（敏感值已打码）</div>
                <div className="max-h-36 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10.5px]">
                  {detail.env.map((entry) => (
                    <div key={entry.key} className="truncate">
                      <span className="text-primary">{entry.key}</span>
                      <span className="text-muted-foreground">={entry.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {detail.command ? <Field label="启动命令" value={detail.command} mono /> : null}
          </div>
        ) : null}
      </Dialog>

      {/* delete confirm */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="删除容器"
        description="容器将被强制删除。若使用绑定挂载，宿主机数据仍会保留。"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void confirmRemove()}>
              删除
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-[12px]">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span className="font-mono">{deleteTarget?.name}</span>
        </div>
      </Dialog>
    </>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('truncate rounded-md bg-muted/40 px-2 py-1.5', mono && 'font-mono text-[11px]')}>{value}</div>
    </div>
  );
}
