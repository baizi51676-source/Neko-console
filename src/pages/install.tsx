// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  GitBranch,
  ExternalLink,
  FileCode2,
  Globe,
  Loader2,
  Package,
  Rocket,
  Search,
  Sparkles,
  Star,
  Terminal,
} from 'lucide-react';
import {
  dockerApi,
  type AppTemplate,
  type DeployJob,
  type RegistrySource,
  type RepoAnalysis,
  type RepoResult,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { Field as FormField, Input } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import { DeployJobsBanner, DeployLog } from '@/components/ui/deploy-log';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type Mode = 'run' | 'compose';
type Tab = 'builtin' | 'search' | 'custom';

interface Draft {
  name: string;
  image: string;
  ports: { host: string; container: string; protocol: string }[];
  volumes: { host: string; container: string; readOnly: boolean }[];
  env: { key: string; value: string }[];
  restart: string;
}

export default function InstallPage() {
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [source, setSource] = useState('github');
  const [tab, setTab] = useState<Tab>('builtin');
  const [loading, setLoading] = useState(true);

  // catalogue search
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [remoteQuery, setRemoteQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<RepoResult[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  // custom install
  const [customUrl, setCustomUrl] = useState('');
  const [analysis, setAnalysis] = useState<RepoAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  // deploy dialog
  const [selected, setSelected] = useState<{ title: string; description?: string; templateId?: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<Mode>('run');
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const toMessage = useApiError();
  const { notify } = useToast();

  useEffect(() => {
    dockerApi
      .catalog()
      .then((data) => {
        setTemplates(data.templates);
        setSources(data.sources);
        setSource(data.sources[0]?.id ?? 'github');
      })
      .catch((error) => notify(toMessage(error), 'error'))
      .finally(() => setLoading(false));
  }, [notify, toMessage]);

  const categories = useMemo(() => ['全部', ...new Set(templates.map((template) => template.category))], [templates]);

  const visibleTemplates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (category !== '全部' && template.category !== category) return false;
      if (!needle) return true;
      return (
        template.name.toLowerCase().includes(needle) ||
        template.description.toLowerCase().includes(needle) ||
        template.image.toLowerCase().includes(needle)
      );
    });
  }, [templates, query, category]);

  /** Seed a draft from a built-in template. */
  const openTemplate = useCallback((template: AppTemplate) => {
    setSelected({ title: `部署 ${template.name}`, description: template.description, templateId: template.id });
    setJobId(null);
    setMode('run');
    setDraft({
      name: template.id,
      image: template.image,
      ports: template.ports.map((port) => ({
        host: String(port.host),
        container: String(port.container),
        protocol: port.protocol ?? 'tcp',
      })),
      volumes: template.volumes.map((volume) => ({
        host: volume.host,
        container: volume.container,
        readOnly: Boolean(volume.readOnly),
      })),
      env: template.env.map((variable) => ({
        key: variable.key,
        value: variable.secret && !variable.default ? generateSecret() : variable.default ?? '',
      })),
      restart: 'unless-stopped',
    });
  }, []);

  /** Seed a draft from an analysed repository. */
  const openAnalysis = useCallback((result: RepoAnalysis) => {
    const shortName = result.repo.split('/')[1]?.toLowerCase().replace(/[^a-z0-9_.-]/g, '') || 'app';
    setSelected({
      title: `部署 ${result.meta.name ?? shortName}`,
      description: result.description || undefined,
    });
    setJobId(null);
    // A repo with a compose file is best deployed as compose; a plain image as run.
    setMode(result.kind === 'compose' ? 'compose' : 'run');
    setDraft({
      name: shortName,
      image: result.image ?? '',
      ports: result.ports.map((port) => ({
        host: String(port.host),
        container: String(port.container),
        protocol: port.protocol ?? 'tcp',
      })),
      volumes: [],
      env: Object.entries(result.env).map(([key, value]) => ({ key, value })),
      restart: 'unless-stopped',
    });
  }, []);

  const previewImage = useMemo(() => {
    if (!draft) return '';
    const src = sources.find((entry) => entry.id === source);
    return src?.imagePrefix ? `${src.imagePrefix}${draft.image}` : draft.image;
  }, [draft, source, sources]);

  const runRemoteSearch = async () => {
    if (!remoteQuery.trim()) return;
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const result = await dockerApi.search(remoteQuery.trim(), 12);
      setRemoteResults(result.results);
      if (result.results.length === 0) setRemoteError('没有找到匹配的仓库');
    } catch (error) {
      setRemoteError(toMessage(error));
      setRemoteResults([]);
    } finally {
      setRemoteLoading(false);
    }
  };

  const analyze = async (url: string) => {
    if (!url.trim()) return;
    setAnalyzing(true);
    setRemoteError(null);
    try {
      const result = await dockerApi.analyze(url.trim());
      setAnalysis(result);
      notify(
        result.kind === 'compose'
          ? '已找到 docker-compose.yml，端口与环境变量已自动填充'
          : result.kind === 'dockerfile'
            ? '找到 Dockerfile，但需要你填写镜像名'
            : '未能自动识别部署方式，请手动填写',
        result.kind === 'unknown' ? 'error' : 'success',
      );
    } catch (error) {
      setAnalysis(null);
      notify(toMessage(error), 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const startDeploy = async () => {
    if (!draft) return;
    setStarting(true);
    try {
      const payload = {
        mode,
        source,
        templateId: selected?.templateId,
        projectName: mode === 'compose' ? draft.name : undefined,
        spec: {
          name: draft.name,
          image: draft.image,
          ports: draft.ports
            .filter((port) => port.container)
            .map((port) => ({
              host: Number(port.host) || null,
              container: Number(port.container),
              protocol: port.protocol,
            })),
          volumes: draft.volumes.filter((volume) => volume.container),
          env: Object.fromEntries(draft.env.filter((entry) => entry.key).map((entry) => [entry.key, entry.value])),
          restart: draft.restart,
        },
      };
      const result = await dockerApi.deploy(payload);
      if (result.jobId) setJobId(result.jobId);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setStarting(false);
    }
  };

  const onJobDone = useCallback(
    (job: DeployJob) => {
      if (job.state === 'succeeded') notify(`${job.name} 部署成功`, 'success');
      else if (job.state === 'failed') notify(job.error ?? '部署失败', 'error');
    },
    [notify],
  );

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="sk-shimmer h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <>
      <DeployJobsBanner onOpen={(id) => setJobId(id)} />

      {/* source selector */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-primary">
            <Globe className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">镜像源</div>
            <div className="text-[11px] text-muted-foreground">国内网络可切换镜像加速，模板元数据始终指向上游项目</div>
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
            {sources.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSource(entry.id)}
                title={entry.hint}
                className={cn(
                  'rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-colors',
                  source === entry.id
                    ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] font-medium text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {/* tabs */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
            {(
              [
                ['builtin', `内置应用 ${templates.length}`],
                ['search', '联网搜索'],
                ['custom', 'GitHub 仓库'],
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
                    layoutId="install-tab"
                    className="absolute inset-0 rounded-md bg-card shadow-xs"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                ) : null}
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>

          {tab === 'builtin' ? (
            <>
              <span className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="筛选应用"
                  className="h-8 w-[160px] pl-8 text-[11.5px]"
                  aria-label="筛选应用"
                />
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {categories.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => setCategory(entry)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11px] transition-colors',
                      category === entry ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {entry}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        {/* --- built-in --- */}
        {tab === 'builtin' ? (
          <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleTemplates.map((template) => (
              <motion.button
                key={template.id}
                type="button"
                onClick={() => openTemplate(template)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="group flex flex-col gap-1.5 rounded-lg border border-border p-3 text-left transition-[border-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-[var(--accent-line)] hover:shadow-card"
              >
                <div className="flex items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-primary">
                    <Package className="size-3.5" />
                  </span>
                  <span className="truncate text-[13px] font-medium">{template.name}</span>
                  <div className="flex-1" />
                  <Badge tone="muted">{template.category}</Badge>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{template.description}</p>
                <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {template.image}
                </code>
                {template.note ? <Badge tone="warning">注意</Badge> : null}
              </motion.button>
            ))}
          </div>
        ) : null}

        {/* --- live search --- */}
        {tab === 'search' ? (
          <div className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative flex-1 min-w-[220px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={remoteQuery}
                  onChange={(event) => setRemoteQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void runRemoteSearch();
                  }}
                  placeholder="搜索 GitHub 上的自托管项目，例如 immich、vaultwarden"
                  className="h-9 pl-8 text-[12px]"
                  aria-label="搜索 GitHub 项目"
                />
              </span>
              <Button size="md" disabled={remoteLoading || !remoteQuery.trim()} onClick={() => void runRemoteSearch()}>
                {remoteLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                搜索
              </Button>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
              结果按 star 排序，优先返回带有 compose 或 Dockerfile 的项目。点击后会读取仓库的
              docker-compose.yml 自动填充端口与环境变量。
            </p>

            {remoteError ? (
              <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
                {remoteError}
              </div>
            ) : null}

            {remoteLoading ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="sk-shimmer h-20 rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {remoteResults.map((repo) => (
                  <div key={repo.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <GitBranch className="size-3.5 shrink-0 text-primary" />
                      <span className="truncate text-[12.5px] font-medium">{repo.fullName}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[10.5px] text-muted-foreground">
                        <Star className="size-3" /> {repo.stars.toLocaleString()}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {repo.description || '（无描述）'}
                    </p>
                    <div className="flex items-center gap-1">
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"
                      >
                        仓库 <ExternalLink className="size-2.5" />
                      </a>
                      <div className="flex-1" />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCustomUrl(repo.htmlUrl);
                          setTab('custom');
                          void analyze(repo.htmlUrl);
                        }}
                      >
                        分析部署
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* --- custom repo --- */}
        {tab === 'custom' ? (
          <div className="flex flex-col gap-3 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <FormField label="GitHub 仓库地址" className="flex-1 min-w-[260px]">
                <Input
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void analyze(customUrl);
                  }}
                  placeholder="https://github.com/owner/repo 或 owner/repo"
                />
              </FormField>
              <Button disabled={analyzing || !customUrl.trim()} onClick={() => void analyze(customUrl)}>
                {analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                分析仓库
              </Button>
            </div>

            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              支持粘贴完整的 GitHub 链接、带分支的链接，或简写 owner/repo。分析时会依次查找
              docker-compose.yml、Dockerfile 与 README——找到 compose 文件即可一键部署。
            </p>

            {analyzing ? <div className="sk-shimmer h-40 rounded-lg" /> : null}

            {analysis && !analyzing ? (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <GitBranch className="size-4 text-primary" />
                  <span className="text-[13px] font-semibold">{analysis.meta.name ?? analysis.repo}</span>
                  <Badge tone={analysis.kind === 'compose' ? 'success' : analysis.kind === 'dockerfile' ? 'warning' : 'muted'}>
                    {analysis.kind === 'compose' ? '找到 compose' : analysis.kind === 'dockerfile' ? '仅 Dockerfile' : '未识别'}
                  </Badge>
                  {analysis.meta.stars !== null && analysis.meta.stars !== undefined ? (
                    <span className="flex items-center gap-0.5 text-[10.5px] text-muted-foreground">
                      <Star className="size-3" /> {analysis.meta.stars.toLocaleString()}
                    </span>
                  ) : null}
                  {analysis.meta.license ? <Badge tone="muted">{analysis.meta.license}</Badge> : null}
                  <div className="flex-1" />
                  <a
                    href={`https://github.com/${analysis.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"
                  >
                    仓库 <ExternalLink className="size-2.5" />
                  </a>
                </div>

                {analysis.description ? (
                  <div>
                    <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">项目描述</div>
                    <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground/80">
                      {analysis.description}
                    </p>
                  </div>
                ) : null}

                {analysis.readme ? (
                  <details className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
                    <summary className="cursor-pointer text-[10.5px] text-muted-foreground">
                      来自 README 的说明
                    </summary>
                    <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                      {analysis.readme}
                    </p>
                  </details>
                ) : null}

                <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                  <span>分支 {analysis.ref}</span>
                  {analysis.image ? <span>镜像 {analysis.image}</span> : null}
                  {analysis.ports.length > 0 ? <span>端口 {analysis.ports.map((p) => p.host).join(', ')}</span> : null}
                  {Object.keys(analysis.env).length > 0 ? <span>{Object.keys(analysis.env).length} 个环境变量</span> : null}
                </div>

                {analysis.note ? (
                  <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
                    {analysis.note}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => openAnalysis(analysis)}>
                    <Rocket className="size-3.5" /> 配置并部署
                  </Button>
                  {analysis.compose ? (
                    <details className="w-full">
                      <summary className="cursor-pointer text-[10.5px] text-muted-foreground">
                        查看仓库的 docker-compose.yml
                      </summary>
                      <pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px]">
                        {analysis.compose}
                      </pre>
                    </details>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* deploy dialog */}
      <Dialog
        open={selected !== null}
        onClose={() => {
          setSelected(null);
          setJobId(null);
        }}
        title={jobId ? '部署进度' : (selected?.title ?? '')}
        description={jobId ? undefined : selected?.description}
        className="max-w-[720px]"
        footer={
          jobId ? (
            <Button onClick={() => { setSelected(null); setJobId(null); }}>完成</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setSelected(null)}>
                取消
              </Button>
              <Button disabled={starting || !draft?.image} onClick={() => void startDeploy()}>
                {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
                开始部署
              </Button>
            </>
          )
        }
      >
        {jobId ? (
          <DeployLog jobId={jobId} onDone={onJobDone} />
        ) : draft ? (
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-foreground/85">部署方式</div>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['run', 'docker run', '单条命令直接启动，适合简单应用', Terminal],
                    ['compose', 'docker compose', '生成可编辑的 compose 文件，便于后续维护', FileCode2],
                  ] as const
                ).map(([value, label, hint, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors',
                      mode === value ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]' : 'border-border hover:bg-accent/50',
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-[12px] font-medium">
                      <Icon className="size-3.5" /> {label}
                      {mode === value ? <Check className="ml-auto size-3.5 text-primary" /> : null}
                    </span>
                    <span className="text-[10.5px] leading-snug text-muted-foreground">{hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="容器名 / 项目名">
                <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </FormField>
              <FormField label="镜像" hint={previewImage ? `实际拉取：${previewImage}` : '请填写镜像名'}>
                <Input
                  value={draft.image}
                  onChange={(event) => setDraft({ ...draft, image: event.target.value })}
                  placeholder="nginx:alpine"
                />
              </FormField>
            </div>

            {/* ports */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-foreground/85">端口映射</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft({ ...draft, ports: [...draft.ports, { host: '', container: '', protocol: 'tcp' }] })}
                >
                  + 添加
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                {draft.ports.map((port, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      value={port.host}
                      placeholder="宿主"
                      onChange={(event) => {
                        const ports = [...draft.ports];
                        ports[index] = { ...port, host: event.target.value };
                        setDraft({ ...draft, ports });
                      }}
                      className="h-8 text-[11.5px]"
                      aria-label="宿主端口"
                    />
                    <span className="text-muted-foreground">→</span>
                    <Input
                      value={port.container}
                      placeholder="容器"
                      onChange={(event) => {
                        const ports = [...draft.ports];
                        ports[index] = { ...port, container: event.target.value };
                        setDraft({ ...draft, ports });
                      }}
                      className="h-8 text-[11.5px]"
                      aria-label="容器端口"
                    />
                    <select
                      value={port.protocol}
                      onChange={(event) => {
                        const ports = [...draft.ports];
                        ports[index] = { ...port, protocol: event.target.value };
                        setDraft({ ...draft, ports });
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
                      onClick={() => setDraft({ ...draft, ports: draft.ports.filter((_, i) => i !== index) })}
                      aria-label="删除端口"
                    >
                      ×
                    </Button>
                  </div>
                ))}
                {draft.ports.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">未配置端口映射，容器将仅在内部网络可达。</p>
                ) : null}
              </div>
            </div>

            {/* volumes */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-foreground/85">目录挂载</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft({ ...draft, volumes: [...draft.volumes, { host: '', container: '', readOnly: false }] })}
                >
                  + 添加
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                {draft.volumes.map((volume, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      value={volume.host}
                      placeholder="/srv/app/data"
                      onChange={(event) => {
                        const volumes = [...draft.volumes];
                        volumes[index] = { ...volume, host: event.target.value };
                        setDraft({ ...draft, volumes });
                      }}
                      className="h-8 font-mono text-[11px]"
                      aria-label="宿主路径"
                    />
                    <span className="text-muted-foreground">→</span>
                    <Input
                      value={volume.container}
                      placeholder="/data"
                      onChange={(event) => {
                        const volumes = [...draft.volumes];
                        volumes[index] = { ...volume, container: event.target.value };
                        setDraft({ ...draft, volumes });
                      }}
                      className="h-8 font-mono text-[11px]"
                      aria-label="容器路径"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDraft({ ...draft, volumes: draft.volumes.filter((_, i) => i !== index) })}
                      aria-label="删除挂载"
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* env */}
            {draft.env.length > 0 ? (
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-foreground/85">环境变量</div>
                <div className="flex flex-col gap-1.5">
                  {draft.env.map((entry, index) => (
                    <div key={entry.key} className="flex items-center gap-1.5">
                      <code className="w-[190px] shrink-0 truncate rounded bg-muted px-1.5 py-1 font-mono text-[10.5px]">
                        {entry.key}
                      </code>
                      <Input
                        value={entry.value}
                        onChange={(event) => {
                          const env = [...draft.env];
                          env[index] = { ...entry, value: event.target.value };
                          setDraft({ ...draft, env });
                        }}
                        className="h-8 text-[11.5px]"
                        aria-label={entry.key}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <FormField label="重启策略">
              <select
                value={draft.restart}
                onChange={(event) => setDraft({ ...draft, restart: event.target.value })}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
              >
                <option value="unless-stopped">unless-stopped（推荐）</option>
                <option value="always">always</option>
                <option value="on-failure">on-failure</option>
                <option value="no">no</option>
              </select>
            </FormField>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** Random password for required secrets, avoiding ambiguous characters. */
function generateSecret(length = 20): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}
