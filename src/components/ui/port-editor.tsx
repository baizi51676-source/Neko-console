// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Plus, RotateCw, X } from 'lucide-react';
import { dockerApi, type ContainerConfig, type DeployJob } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field as FormField, Input } from '@/components/ui/field';
import { DeployLog } from '@/components/ui/deploy-log';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

interface PortRow {
  host: string;
  container: string;
  protocol: string;
}

/**
 * Container port editor.
 *
 * Docker cannot change a binding in place, so this recreates the container. The
 * dialog says so up front and shows the rollback behaviour, because "edit ports"
 * sounds harmless and is not: it stops the container and starts a new one.
 */
export function PortEditor({
  name,
  open,
  onClose,
  onDone,
}: {
  name: string | null;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [config, setConfig] = useState<ContainerConfig | null>(null);
  const [usedPorts, setUsedPorts] = useState<{ port: number; owner: string }[]>([]);
  const [rows, setRows] = useState<PortRow[]>([]);
  const [restartPolicy, setRestartPolicy] = useState('no');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    setError(null);
    setJobId(null);
    try {
      const result = await dockerApi.containerConfig(name);
      setConfig(result.config);
      setUsedPorts(result.usedPorts);
      setRestartPolicy(result.config.restartPolicy);
      setRows(
        result.config.ports.map((port) => ({
          host: port.host === null ? '' : String(port.host),
          container: String(port.container),
          protocol: port.protocol,
        })),
      );
    } catch (err) {
      setConfig(null);
      setError(toMessage(err));
    } finally {
      setLoading(false);
    }
  }, [name, toMessage]);

  useEffect(() => {
    if (open) void load();
    else {
      setConfig(null);
      setError(null);
      setJobId(null);
    }
  }, [open, load]);

  /** Ports already taken by other containers, for inline warnings. */
  const conflicts = rows
    .map((row) => ({ row, port: Number(row.host) }))
    .filter(({ port }) => Number.isFinite(port) && port > 0)
    .map(({ row, port }) => ({ row, port, clash: usedPorts.find((entry) => entry.port === port) }))
    .filter((entry) => entry.clash);

  const duplicateHost = rows
    .map((row) => row.host)
    .filter((host, index, all) => host && all.indexOf(host) !== index);

  const apply = async () => {
    if (!name) return;
    setError(null);
    try {
      const result = await dockerApi.updatePorts(
        name,
        rows
          .filter((row) => row.container)
          .map((row) => ({
            host: row.host === '' ? null : Number(row.host),
            container: Number(row.container),
            protocol: row.protocol,
          })),
      );
      setJobId(result.jobId);
      notify('开始重建容器', 'success');
    } catch (err) {
      setError(toMessage(err));
    }
  };

  const onJobDone = useCallback(
    (job: DeployJob) => {
      if (job.state === 'succeeded') {
        notify('端口映射已更新', 'success');
        onDone?.();
      } else if (job.state === 'failed') {
        notify(job.error ?? '端口更新失败', 'error');
      }
    },
    [notify, onDone],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={jobId ? '正在重建容器' : `编辑端口映射${name ? ` · ${name}` : ''}`}
      description={jobId ? undefined : '修改端口需要重建容器，过程中服务会短暂中断'}
      className="max-w-[640px]"
      footer={
        jobId ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button disabled={loading || Boolean(error) || conflicts.length > 0 || duplicateHost.length > 0} onClick={() => void apply()}>
              <RotateCw className="size-3.5" /> 重建并应用
            </Button>
          </>
        )
      }
    >
      {jobId ? (
        <DeployLog jobId={jobId} onDone={onJobDone} />
      ) : loading ? (
        <div className="sk-shimmer h-40 rounded-lg" />
      ) : !config ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {error ?? '无法读取容器配置'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Docker 无法在运行中修改端口。保存时会把容器重命名备份，用新端口重建一个同样的容器；
              若启动失败会自动回滚到原容器。数据卷与环境变量会一并保留。
            </span>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>镜像 <code className="font-mono">{config.image}</code></span>
            <span>状态 {config.state}</span>
            <span>网络 {config.networkMode}</span>
            <span>{config.mounts.length} 个挂载</span>
            <span>{config.env.length} 个环境变量</span>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[12px] font-medium text-foreground/85">端口映射</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRows([...rows, { host: '', container: '', protocol: 'tcp' }])}
              >
                <Plus className="size-3" /> 添加
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              {rows.map((row, index) => {
                const clash = usedPorts.find((entry) => entry.port === Number(row.host) && row.host !== '');
                return (
                  <div key={index} className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={row.host}
                        placeholder="宿主（留空=随机）"
                        onChange={(event) => {
                          const next = [...rows];
                          next[index] = { ...row, host: event.target.value };
                          setRows(next);
                        }}
                        className={cn('h-8 text-[11.5px]', clash && 'border-destructive')}
                        aria-label="宿主端口"
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        value={row.container}
                        placeholder="容器"
                        onChange={(event) => {
                          const next = [...rows];
                          next[index] = { ...row, container: event.target.value };
                          setRows(next);
                        }}
                        className="h-8 text-[11.5px]"
                        aria-label="容器端口"
                      />
                      <select
                        value={row.protocol}
                        onChange={(event) => {
                          const next = [...rows];
                          next[index] = { ...row, protocol: event.target.value };
                          setRows(next);
                        }}
                        aria-label="协议"
                        className="h-8 rounded-md border border-input bg-transparent px-1.5 text-[11.5px]"
                      >
                        <option value="tcp">tcp</option>
                        <option value="udp">udp</option>
                      </select>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRows(rows.filter((_, i) => i !== index))}
                        aria-label="删除端口"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                    {clash ? (
                      <p className="text-[10.5px] text-destructive">端口 {clash.port} 已被容器 {clash.owner} 占用</p>
                    ) : null}
                  </div>
                );
              })}
              {rows.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">当前没有端口映射。</p>
              ) : null}
            </div>

            {duplicateHost.length > 0 ? (
              <p className="mt-1.5 text-[10.5px] text-destructive">
                宿主端口重复：{duplicateHost.join(', ')}
              </p>
            ) : null}
          </div>

          <FormField label="重启策略" hint="此选项可原地修改，不需要重建容器">
            <div className="flex items-center gap-2">
              <select
                value={restartPolicy}
                onChange={(event) => setRestartPolicy(event.target.value)}
                className="h-9 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px]"
              >
                <option value="no">no</option>
                <option value="always">always</option>
                <option value="unless-stopped">unless-stopped</option>
                <option value="on-failure">on-failure</option>
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={restartPolicy === config.restartPolicy}
                onClick={async () => {
                  try {
                    await dockerApi.updateRestartPolicy(config.name, restartPolicy);
                    notify('重启策略已更新', 'success');
                    await load();
                    onDone?.();
                  } catch (err) {
                    notify(toMessage(err), 'error');
                  }
                }}
              >
                应用
              </Button>
            </div>
          </FormField>

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
              {error}
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
