// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Database,
  FolderArchive,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { panelApi, type BackupRow, type DbEngine } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, PageHeader } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

export default function BackupsPage() {
  const [entries, setEntries] = useState<BackupRow[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [keep, setKeep] = useState(5);
  const [dir, setDir] = useState('');
  const [engines, setEngines] = useState<DbEngine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [dbTarget, setDbTarget] = useState<{ engine: string; database: string } | null>(null);
  const [siteTarget, setSiteTarget] = useState<{ label: string; path: string } | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; path: string; expected?: string; actual?: string; reason?: string } | null>(null);

  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(async () => {
    try {
      const [backupResult, engineResult] = await Promise.all([panelApi.backups(), panelApi.engines()]);
      setEntries(backupResult.entries);
      setTotalSize(backupResult.totalSize);
      setKeep(backupResult.keep);
      setDir(backupResult.dir);
      setEngines(engineResult.engines.filter((entry) => entry.available));
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, toMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const runFull = async () => {
    setBusy('full');
    try {
      const result = await panelApi.runBackup({ kind: 'full' });
      notify(
        `备份完成：${result.files?.length ?? 0} 个文件，共 ${formatBytes(result.totalSize ?? 0)}`,
        'success',
      );
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const runDatabase = async () => {
    if (!dbTarget?.database) return;
    setBusy('database');
    try {
      const result = await panelApi.runBackup({ kind: 'database', engine: dbTarget.engine, database: dbTarget.database });
      notify(`数据库已备份：${formatBytes(result.size ?? 0)}`, 'success');
      setDbTarget(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const runSite = async () => {
    if (!siteTarget?.path) return;
    setBusy('site');
    try {
      const result = await panelApi.runBackup({ kind: 'site', label: siteTarget.label, path: siteTarget.path });
      notify(`站点已打包：${formatBytes(result.size ?? 0)}`, 'success');
      setSiteTarget(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const verify = async (path: string) => {
    try {
      const result = await panelApi.verifyBackup(path);
      setVerifyResult({ path, ...result });
    } catch (error) {
      notify(toMessage(error), 'error');
    }
  };

  const prune = async () => {
    setBusy('prune');
    try {
      const result = await panelApi.pruneBackups();
      notify(`已清理 ${result.removed.length} 个旧备份`, 'success');
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
        {[0, 1, 2].map((index) => (
          <div key={index} className="sk-shimmer h-20 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="备份"
        description="数据库逻辑备份与站点目录打包，每个归档都带 SHA-256 校验值。"
        actions={
          <>
            <Button variant="outline" onClick={() => void load()}>
              <RefreshCw className="size-3.5" /> 刷新
            </Button>
            <Button disabled={busy === 'full'} onClick={() => void runFull()}>
              {busy === 'full' ? <Loader2 className="size-3.5 animate-spin" /> : <HardDrive className="size-3.5" />}
              全量备份
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <Card className="p-3">
          <div className="text-[10.5px] text-muted-foreground">归档数量</div>
          <div className="mt-0.5 text-[18px] font-semibold">{entries.length}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10.5px] text-muted-foreground">占用空间</div>
          <div className="mt-0.5 text-[18px] font-semibold">{formatBytes(totalSize)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10.5px] text-muted-foreground">保留策略</div>
          <div className="mt-0.5 text-[13px] font-medium">每类保留 {keep} 份</div>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setDbTarget({ engine: engines[0]?.id ?? 'mysql', database: '' })}>
          <Database className="size-3.5" /> 备份单个数据库
        </Button>
        <Button variant="outline" onClick={() => setSiteTarget({ label: '', path: '' })}>
          <FolderArchive className="size-3.5" /> 备份站点目录
        </Button>
        <Button variant="outline" disabled={busy === 'prune'} onClick={() => void prune()}>
          {busy === 'prune' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          清理旧备份
        </Button>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title="还没有备份"
          description={`备份会写入 ${dir || '/var/backups/neko-console'}，每类保留最近 ${keep} 份。`}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => (
            <Card key={entry.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-lg',
                    entry.kind === 'database' ? 'bg-[var(--accent-soft)] text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {entry.kind === 'database' ? <Database className="size-4" /> : <FolderArchive className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] font-medium">{entry.label}</span>
                    <Badge tone="muted">{entry.kind === 'database' ? '数据库' : '站点'}</Badge>
                    <span className="text-[10.5px] text-muted-foreground">{formatBytes(entry.size)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                    <span className="truncate font-mono">{entry.path}</span>
                  </div>
                  {entry.sha256 ? (
                    <div className="mt-0.5 truncate font-mono text-[9.5px] text-muted-foreground/70">
                      sha256:{entry.sha256.slice(0, 32)}…
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void verify(entry.path)}>
                    <ShieldCheck className="size-3.5" /> 校验
                  </Button>
                </div>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {new Date(entry.created_at).toLocaleString('zh-CN')}
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          备份保存在本机，不做离线上传 —— 磁盘故障时备份也会一起丢失。
          重要数据请自行用 <code className="font-mono">rsync</code> 或 <code className="font-mono">rclone</code>
          同步到外部位置。
        </span>
      </div>

      {/* database backup dialog */}
      <Dialog
        open={dbTarget !== null}
        onClose={() => setDbTarget(null)}
        title="备份数据库"
        description="使用 mysqldump --single-transaction，不锁表。"
        footer={
          <>
            <Button variant="outline" onClick={() => setDbTarget(null)}>
              取消
            </Button>
            <Button disabled={busy === 'database' || !dbTarget?.database} onClick={() => void runDatabase()}>
              {busy === 'database' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              开始备份
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="数据库名">
            <Input
              value={dbTarget?.database ?? ''}
              onChange={(event) => setDbTarget({ engine: dbTarget?.engine ?? 'mysql', database: event.target.value })}
              placeholder="myapp"
              className="font-mono"
            />
          </Field>
          {engines.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">未检测到可用的数据库引擎，但仍可手动填写数据库名尝试。</p>
          ) : null}
        </div>
      </Dialog>

      {/* site backup dialog */}
      <Dialog
        open={siteTarget !== null}
        onClose={() => setSiteTarget(null)}
        title="备份站点目录"
        description="自动排除 node_modules 与 .git，不跟随符号链接。"
        footer={
          <>
            <Button variant="outline" onClick={() => setSiteTarget(null)}>
              取消
            </Button>
            <Button disabled={busy === 'site' || !siteTarget?.path} onClick={() => void runSite()}>
              {busy === 'site' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              开始打包
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="标签" hint="用于文件名">
            <Input
              value={siteTarget?.label ?? ''}
              onChange={(event) => setSiteTarget({ label: event.target.value, path: siteTarget?.path ?? '' })}
              placeholder="myapp"
            />
          </Field>
          <Field label="目录绝对路径">
            <Input
              value={siteTarget?.path ?? ''}
              onChange={(event) => setSiteTarget({ label: siteTarget?.label ?? '', path: event.target.value })}
              placeholder="/srv/www/myapp"
              className="font-mono"
            />
          </Field>
        </div>
      </Dialog>

      {/* verify result */}
      <Dialog
        open={verifyResult !== null}
        onClose={() => setVerifyResult(null)}
        title="校验结果"
        footer={<Button onClick={() => setVerifyResult(null)}>关闭</Button>}
      >
        {verifyResult ? (
          <div className="flex flex-col gap-2">
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]',
                verifyResult.ok
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-destructive/40 bg-destructive/10 text-destructive',
              )}
            >
              {verifyResult.ok ? <Check className="size-4" /> : <X className="size-4" />}
              {verifyResult.ok ? '哈希一致，归档完整' : (verifyResult.reason ?? '哈希不一致，归档可能已损坏')}
            </div>
            <div className="flex flex-col gap-1 font-mono text-[10px] text-muted-foreground">
              <div className="truncate">路径 {verifyResult.path}</div>
              {verifyResult.expected ? <div className="truncate">记录 {verifyResult.expected}</div> : null}
              {verifyResult.actual ? <div className="truncate">实际 {verifyResult.actual}</div> : null}
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
