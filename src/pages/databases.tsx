// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Database, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { panelApi, type DbEngine } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, Card, PageHeader } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

export default function DatabasesPage() {
  const [engines, setEngines] = useState<DbEngine[]>([]);
  const [engine, setEngine] = useState('mysql');
  const [databases, setDatabases] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ database: '', username: '', charset: 'utf8mb4' });

  /** Credentials are shown once, after creation, and never stored. */
  const [issued, setIssued] = useState<{ database: string; username: string; password: string; engine: string } | null>(null);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteUser, setDeleteUser] = useState('');

  const toMessage = useApiError();
  const { notify } = useToast();

  const loadEngines = useCallback(async () => {
    try {
      const result = await panelApi.engines();
      setEngines(result.engines);
      const firstAvailable = result.engines.find((entry) => entry.available);
      if (firstAvailable) setEngine(firstAvailable.id);
    } catch (error) {
      notify(toMessage(error), 'error');
    }
  }, [notify, toMessage]);

  const loadDatabases = useCallback(
    async (target: string) => {
      try {
        const result = await panelApi.listDatabases(target);
        setDatabases(result.databases);
      } catch {
        // Listing can fail while the engine is down; the create form still works.
        setDatabases([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadEngines();
  }, [loadEngines]);

  useEffect(() => {
    if (engine) void loadDatabases(engine);
  }, [engine, loadDatabases]);

  const active = engines.find((entry) => entry.id === engine);

  const create = async () => {
    setBusy('create');
    try {
      const result = await panelApi.createDatabase({
        engine,
        database: draft.database,
        username: draft.username,
        charset: draft.charset,
      });
      setIssued({ database: result.database, username: result.username, password: result.password, engine });
      setCreating(false);
      setDraft({ database: '', username: '', charset: 'utf8mb4' });
      await loadDatabases(engine);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const drop = async () => {
    if (!deleting) return;
    setBusy('drop');
    try {
      await panelApi.dropDatabase({
        engine,
        database: deleting,
        username: deleteUser || undefined,
        force: true,
      });
      notify(`已删除数据库 ${deleting}`, 'success');
      setDeleting(null);
      setDeleteUser('');
      await loadDatabases(engine);
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
        title="数据库"
        description="创建与删除数据库和账号。本页只管生命周期，不做表结构浏览或数据导出。"
        actions={
          <>
            <Button variant="outline" onClick={() => void loadDatabases(engine)}>
              <RefreshCw className="size-3.5" /> 刷新
            </Button>
            <Button disabled={!active?.available} onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> 新建数据库
            </Button>
          </>
        }
      />

      {/* engine selector */}
      <Card className="mb-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-primary">
            <Database className="size-4" />
          </span>
          <span className="text-[12px] font-medium">数据库引擎</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {engines.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">未检测到 MySQL 或 PostgreSQL 客户端</span>
            ) : (
              engines.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setEngine(entry.id)}
                  disabled={!entry.available}
                  className={cn(
                    'rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-colors',
                    engine === entry.id
                      ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] font-medium text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                    !entry.available && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {entry.label}
                  {entry.available ? null : ' (不可用)'}
                </button>
              ))
            )}
          </div>
          {active?.version ? (
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{active.version}</span>
          ) : null}
        </div>

        {active?.hint ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[10.5px] text-warning">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {active.hint}
          </div>
        ) : null}
      </Card>

      {databases.length === 0 ? (
        <EmptyState
          icon={Database}
          title={active?.available ? '还没有数据库' : '数据库不可用'}
          description={
            active?.available
              ? '创建数据库时会同时创建一个只拥有该库权限的账号。'
              : (active?.hint ?? '请先安装并启动数据库服务。')
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {databases.map((name) => (
            <Card key={name} className="flex items-center gap-2 p-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <Database className="size-3.5" />
              </span>
              <span className="font-mono text-[12.5px] font-medium">{name}</span>
              <div className="ml-auto">
                <Button variant="ghost" size="sm" onClick={() => setDeleting(name)} aria-label={`删除 ${name}`}>
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="mt-3 text-[10.5px] leading-relaxed text-muted-foreground">
        本页只负责「建库 / 建用户 / 删库」，不提供表结构浏览、SQL 执行或导入导出 ——
        需要这些请使用 phpMyAdmin 或 pgAdmin。面板不会保存任何数据库密码。
      </p>

      {/* create dialog */}
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="新建数据库"
        description="会创建一个数据库，以及一个只对该库有全部权限的账号。"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button
              disabled={busy === 'create' || !draft.database || !draft.username}
              onClick={() => void create()}
            >
              {busy === 'create' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              创建
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="数据库名" hint="字母、数字、下划线，以字母或下划线开头">
            <Input
              value={draft.database}
              onChange={(event) => setDraft({ ...draft, database: event.target.value })}
              placeholder="myapp"
              className="font-mono"
            />
          </Field>
          <Field label="用户名" hint="同名账号会自动创建">
            <Input
              value={draft.username}
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
              placeholder="myapp_user"
              className="font-mono"
            />
          </Field>
          {engine === 'mysql' ? (
            <Field label="字符集">
              <select
                value={draft.charset}
                onChange={(event) => setDraft({ ...draft, charset: event.target.value })}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
              >
                <option value="utf8mb4">utf8mb4（推荐）</option>
                <option value="utf8">utf8</option>
                <option value="latin1">latin1</option>
              </select>
            </Field>
          ) : null}
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            密码会自动随机生成，只在创建成功后显示一次，请立即保存。面板不会存储它。
          </div>
        </div>
      </Dialog>

      {/* credentials shown once */}
      <Dialog
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="数据库已创建"
        description="密码只显示这一次，关闭后无法再查看。"
        footer={<Button onClick={() => setIssued(null)}>我已保存</Button>}
      >
        {issued ? (
          <div className="flex flex-col gap-2">
            {(
              [
                ['数据库', issued.database],
                ['用户名', issued.username],
                ['密码', issued.password],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
                <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11.5px]">
                  {value}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`复制${label}`}
                  onClick={() => {
                    void navigator.clipboard.writeText(value).then(
                      () => notify(`${label}已复制`, 'success'),
                      () => notify('复制失败，请手动选择', 'error'),
                    );
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            ))}
            <div className="mt-1 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[10.5px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              关闭此对话框后将无法再次查看密码。如需重置，请在你的数据库管理工具中操作。
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* delete confirm */}
      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
          setDeleteUser('');
        }}
        title={`删除数据库 ${deleting ?? ''}`}
        description="此操作不可恢复，数据库内所有表和数据都会被删除。"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setDeleting(null);
                setDeleteUser('');
              }}
            >
              取消
            </Button>
            <Button variant="destructive" disabled={busy === 'drop'} onClick={() => void drop()}>
              {busy === 'drop' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              确认删除
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            数据库 <code className="font-mono">{deleting}</code> 及其全部数据将被永久删除。
          </div>
          <Field label="同时删除账号（可选）" hint="留空则只删库，保留账号">
            <Input
              value={deleteUser}
              onChange={(event) => setDeleteUser(event.target.value)}
              placeholder="myapp_user"
              className="font-mono"
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
