// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileCode2,
  Globe,
  Lock,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { panelApi, type CertificateRow, type SiteRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, PageHeader } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type Tab = 'sites' | 'certs';

export default function SitesPage() {
  const [tab, setTab] = useState<Tab>('sites');
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [certs, setCerts] = useState<CertificateRow[]>([]);
  const [certTimer, setCertTimer] = useState<{ installed: boolean; next: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // editor
  const [editing, setEditing] = useState<SiteRow | 'new' | null>(null);
  const [draft, setDraft] = useState({
    name: '',
    kind: 'proxy' as 'proxy' | 'static',
    serverNames: '',
    upstream: '127.0.0.1:3000',
    rootPath: '',
    indexed: true,
    ssl: false,
  });
  const [preview, setPreview] = useState<string | null>(null);

  // delete
  const [deleting, setDeleting] = useState<SiteRow | null>(null);

  // certificate issuance
  const [certTarget, setCertTarget] = useState<{ domains: string; siteId?: string } | null>(null);

  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(async () => {
    try {
      const [siteResult, certResult] = await Promise.all([panelApi.sites(), panelApi.certificates()]);
      setSites(siteResult.sites);
      setCerts(certResult.certificates);
      setCertTimer(certResult.timer);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [notify, toMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (site: SiteRow | 'new') => {
    setEditing(site);
    setPreview(null);
    if (site === 'new') {
      setDraft({ name: '', kind: 'proxy', serverNames: '', upstream: '127.0.0.1:3000', rootPath: '/srv/www/', indexed: true, ssl: false });
    } else {
      setDraft({
        name: site.name,
        kind: site.kind,
        serverNames: site.server_names,
        upstream: site.upstream ?? '127.0.0.1:3000',
        rootPath: site.root_path ?? '',
        indexed: Boolean(site.indexed),
        ssl: Boolean(site.ssl),
      });
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const payload = {
        name: draft.name,
        kind: draft.kind,
        serverNames: draft.serverNames,
        upstream: draft.kind === 'proxy' ? draft.upstream : undefined,
        rootPath: draft.kind === 'static' ? draft.rootPath : undefined,
        indexed: draft.indexed,
        ssl: draft.ssl,
      };
      if (editing === 'new') {
        await panelApi.createSite(payload);
        notify('站点已创建，nginx 已重载', 'success');
      } else if (editing) {
        await panelApi.updateSite({ ...payload, id: editing.id });
        notify('站点已更新', 'success');
      }
      setEditing(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy('delete');
    try {
      await panelApi.deleteSite(deleting.id);
      notify('站点已删除', 'success');
      setDeleting(null);
      await load();
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const showPreview = async () => {
    if (!editing || editing === 'new') return;
    try {
      const result = await panelApi.sitePreview(editing.id);
      setPreview(result.config);
    } catch (error) {
      notify(toMessage(error), 'error');
    }
  };

  const sitesWithSsl = useMemo(() => sites.filter((site) => Boolean(site.ssl)), [sites]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="sk-shimmer h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="网站管理"
        description="反向代理与静态站点，配置由 Neko-console 托管并自动校验。"
        actions={
          <>
            <Button variant="outline" onClick={() => void load()}>
              <RefreshCw className="size-3.5" /> 刷新
            </Button>
            <Button onClick={() => openEditor('new')}>
              <Plus className="size-3.5" /> 新建站点
            </Button>
          </>
        }
      />

      <div className="mb-3 flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5 w-fit">
        {(
          [
            ['sites', `站点 ${sites.length}`],
            ['certs', `证书 ${certs.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'relative rounded-md px-3 py-1 text-[11.5px] transition-colors',
              tab === key ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab === key ? (
              <motion.span
                layoutId="sites-tab"
                className="absolute inset-0 rounded-md bg-card shadow-xs"
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              />
            ) : null}
            <span className="relative">{label}</span>
          </button>
        ))}
      </div>

      {tab === 'sites' ? (
        sites.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="还没有站点"
            description="创建一个反向代理指向本机服务，或托管一个静态目录。"
            action={
              <Button onClick={() => openEditor('new')}>
                <Plus className="size-3.5" /> 新建站点
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {sites.map((site) => (
              <Card key={site.id} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-primary">
                    {site.kind === 'proxy' ? <RefreshCw className="size-4" /> : <FileCode2 className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium">{site.name}</span>
                      <Badge tone={site.kind === 'proxy' ? 'muted' : 'muted'}>
                        {site.kind === 'proxy' ? '反向代理' : '静态站点'}
                      </Badge>
                      {site.ssl ? (
                        <Badge tone="success">
                          <Lock className="mr-0.5 inline size-2.5" /> HTTPS
                        </Badge>
                      ) : null}
                      {!site.rendered ? <Badge tone="warning">未渲染</Badge> : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="font-mono">{site.server_names}</span>
                      <span>→ {site.kind === 'proxy' ? site.upstream : site.root_path}</span>
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEditor(site)}>
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCertTarget({ domains: site.server_names, siteId: site.id })}
                    >
                      <ShieldCheck className="size-3.5" /> 证书
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(site)} aria-label="删除站点">
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2">
          {certTimer ? (
            <Card className="p-3">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="grid size-7 place-items-center rounded-md bg-[var(--accent-soft)] text-primary">
                  <ShieldCheck className="size-3.5" />
                </span>
                <span className="font-medium">自动续期</span>
                {certTimer.installed ? (
                  <Badge tone="success">已安装 systemd timer</Badge>
                ) : (
                  <Badge tone="warning">未安装</Badge>
                )}
                {certTimer.next ? <span className="text-muted-foreground">下次 {certTimer.next}</span> : null}
                <div className="ml-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === 'timer' || certTimer.installed}
                    onClick={async () => {
                      setBusy('timer');
                      try {
                        await panelApi.installCertTimer();
                        notify('续期定时器已安装', 'success');
                        await load();
                      } catch (error) {
                        notify(toMessage(error), 'error');
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === 'timer' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                    安装续期定时器
                  </Button>
                </div>
              </div>
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                续期由 systemd timer 每天执行，不在 Node 进程内跑定时器 —— 控制台停机不会导致证书过期。
                面板只做巡检，不自动续期。
              </p>
            </Card>
          ) : null}

          {certs.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="还没有证书"
              description="为已解析到本机的域名申请 Let's Encrypt 证书。申请前请确认 80 端口可从公网访问。"
            />
          ) : (
            certs.map((cert) => (
              <Card key={cert.lineage} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-lg',
                      cert.expired
                        ? 'bg-destructive/15 text-destructive'
                        : cert.expiringSoon
                          ? 'bg-warning/15 text-warning'
                          : 'bg-success/15 text-success',
                    )}
                  >
                    <Lock className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium">{cert.lineage}</span>
                      {cert.expired ? (
                        <Badge tone="destructive">已过期</Badge>
                      ) : cert.expiringSoon ? (
                        <Badge tone="warning">{cert.daysLeft} 天后到期</Badge>
                      ) : (
                        <Badge tone="success">剩余 {cert.daysLeft} 天</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      到期 {new Date(cert.expiresAt).toLocaleString('zh-CN')}
                      {cert.altNames.length > 0 ? ` · ${cert.altNames.join(', ')}` : ''}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === `renew-${cert.lineage}`}
                      onClick={async () => {
                        setBusy(`renew-${cert.lineage}`);
                        try {
                          await panelApi.renewCertificate(cert.lineage);
                          notify('续期请求已提交', 'success');
                          await load();
                        } catch (error) {
                          notify(toMessage(error), 'error');
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === `renew-${cert.lineage}` ? <Loader2 className="size-3 animate-spin" /> : null}
                      续期
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}

          {sitesWithSsl.length === 0 && certs.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">提示：将站点的 SSL 打开后，证书才会被站点引用。</p>
          ) : null}
        </div>
      )}

      {/* site editor */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? '新建站点' :`编辑站点 ${editing?.name ?? ''}`}
        description="保存后会写入托管目录、执行 nginx -t 校验并重载；校验失败会自动回滚。"
        className="max-w-[600px]"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            {editing !== 'new' ? (
              <Button variant="outline" onClick={() => void showPreview()}>
                预览配置
              </Button>
            ) : null}
            <Button disabled={busy === 'save' || !draft.name || !draft.serverNames} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存并重载
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="站点名" hint="用于配置文件名，小写字母数字">
              <Input
                value={draft.name}
                disabled={editing !== 'new'}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="myapp"
              />
            </Field>
            <Field label="域名" hint="多个用逗号分隔">
              <Input
                value={draft.serverNames}
                onChange={(event) => setDraft({ ...draft, serverNames: event.target.value })}
                placeholder="app.example.com, www.app.example.com"
              />
            </Field>
          </div>

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-foreground/85">类型</div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['proxy', '反向代理', '转发到本机端口', RefreshCw],
                  ['static', '静态站点', '托管一个目录', FileCode2],
                ] as const
              ).map(([value, label, hint, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDraft({ ...draft, kind: value })}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors',
                    draft.kind === value ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]' : 'border-border hover:bg-accent/50',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-medium">
                    <Icon className="size-3.5" /> {label}
                    {draft.kind === value ? <Check className="ml-auto size-3.5 text-primary" /> : null}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {draft.kind === 'proxy' ? (
            <Field label="上游地址" hint="只允许本机，例如 127.0.0.1:3000">
              <Input
                value={draft.upstream}
                onChange={(event) => setDraft({ ...draft, upstream: event.target.value })}
                placeholder="127.0.0.1:3000"
                className="font-mono"
              />
            </Field>
          ) : (
            <>
              <Field label="站点目录" hint="绝对路径">
                <Input
                  value={draft.rootPath}
                  onChange={(event) => setDraft({ ...draft, rootPath: event.target.value })}
                  placeholder="/srv/www/myapp"
                  className="font-mono"
                />
              </Field>
              <label className="flex items-center gap-2 text-[11.5px]">
                <input
                  type="checkbox"
                  checked={draft.indexed}
                  onChange={(event) => setDraft({ ...draft, indexed: event.target.checked })}
                />
                允许目录列表（autoindex）
              </label>
            </>
          )}

          <label className="flex items-center gap-2 text-[11.5px]">
            <input
              type="checkbox"
              checked={draft.ssl}
              onChange={(event) => setDraft({ ...draft, ssl: event.target.checked })}
            />
            启用 HTTPS（需要先为该域名签发证书）
          </label>

          {draft.ssl && editing === 'new' ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              新站点启用 HTTPS 前，请先用「证书」页申请证书，否则 nginx 校验会失败。
            </div>
          ) : null}

          {preview ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">生成的配置</div>
              <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10px]">
                {preview}
              </pre>
            </div>
          ) : null}
        </div>
      </Dialog>

      {/* delete confirm */}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`删除站点 ${deleting?.name ?? ''}`}
        description="只删除 Neko-console 托管的配置文件，不会动 sites-enabled 下你手写的文件。"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy === 'delete'} onClick={() => void remove()}>
              {busy === 'delete' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-muted-foreground">
          站点 <code className="font-mono">{deleting?.server_names}</code> 将不再被 nginx 服务。
        </p>
      </Dialog>

      {/* certificate issuance */}
      <IssueCertificateDialog
        target={certTarget}
        onClose={() => setCertTarget(null)}
        onDone={() => {
          setCertTarget(null);
          void load();
        }}
      />
    </>
  );
}

/**
 * Certificate issuance dialog.
 *
 * Kept separate because issuance is slow and its errors are specific (DNS not
 * pointing here, port 80 blocked) — those need to be shown prominently rather
 * than as a toast.
 */
function IssueCertificateDialog({
  target,
  onClose,
  onDone,
}: {
  target: { domains: string; siteId?: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [domains, setDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setDomains(target.domains);
      setError(null);
      setDetail(null);
    }
  }, [target]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      const list = domains.split(',').map((entry) => entry.trim()).filter(Boolean);
      await panelApi.issueCertificate(list);
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : '申请失败';
      setError(message);
      const apiDetail = (err as { detail?: string }).detail;
      if (apiDetail) setDetail(apiDetail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title="申请证书"
      description="通过 Let's Encrypt webroot 验证，全程不修改 nginx 配置。"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !domains.trim()} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            {busy ? '申请中…' : '开始申请'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="域名" hint="逗号分隔，第一个作为证书名">
          <Input value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="app.example.com" />
        </Field>

        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            申请前请确认：域名已解析到本机公网 IP、80 端口可从外网访问、且该域名已有站点（或至少 nginx 在运行）。
            Let's Encrypt 会从公网验证域名归属。
          </span>
        </div>

        {busy ? (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2 text-[11.5px]">
            <Loader2 className="size-3.5 animate-spin" /> 正在与 Let's Encrypt 交互，通常需要 10-30 秒…
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
            {error}
          </div>
        ) : null}
        {detail ? (
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10px] text-muted-foreground">
            {detail}
          </pre>
        ) : null}

        <a
          href="https://letsencrypt.org/docs/challenge-types/#http-01-challenge"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"
        >
          了解 HTTP-01 验证 <ExternalLink className="size-2.5" />
        </a>
      </div>
    </Dialog>
  );
}
