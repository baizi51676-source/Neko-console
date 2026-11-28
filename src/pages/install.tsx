// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  FileCode2,
  Globe,
  Loader2,
  Package,
  Rocket,
  Search,
  Terminal,
} from 'lucide-react';
import { dockerApi, type AppTemplate, type DeployResult, type RegistrySource } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { Field as FormField, Input } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

type Mode = 'run' | 'compose';

/** Editable projection of a template, so the form can diverge from defaults. */
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
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [selected, setSelected] = useState<AppTemplate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<Mode>('run');
  const [deploying, setDeploying] = useState(false);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [loading, setLoading] = useState(true);

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

  const visible = useMemo(() => {
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

  /** Open the configure dialog, seeding the draft from the template defaults. */
  const openTemplate = useCallback((template: AppTemplate) => {
    setSelected(template);
    setResult(null);
    setMode('run');
    setDraft({
      name: template.id,
      image: template.image,
      ports: template.ports.map((port) => ({
        host: String(port.host),
        container: String(port.container),
        protocol: port.protocol ?? 'tcp',
      })),
      volumes: template.volumes.map((volume) => ({ host: volume.host, container: volume.container, readOnly: Boolean(volume.readOnly) })),
      // Generate a random value for required secrets so the deploy succeeds
      // without the user having to invent one — it is shown in the result.
      env: template.env.map((variable) => ({
        key: variable.key,
        value: variable.secret && !variable.default ? generateSecret() : variable.default ?? '',
      })),
      restart: 'unless-stopped',
    });
  }, []);

  const previewImage = useMemo(() => {
    if (!draft) return '';
    const src = sources.find((entry) => entry.id === source);
    return src?.imagePrefix ? `${src.imagePrefix}${draft.image}` : draft.image;
  }, [draft, source, sources]);

  const deploy = async () => {
    if (!draft || !selected) return;
    setDeploying(true);
    setResult(null);
    try {
      const payload = {
        mode,
        source,
        templateId: selected.id,
        projectName: mode === 'compose' ? draft.name : undefined,
        spec: {
          name: draft.name,
          image: draft.image,
          ports: draft.ports
            .filter((port) => port.host && port.container)
            .map((port) => ({ host: Number(port.host), container: Number(port.container), protocol: port.protocol })),
          volumes: draft.volumes.filter((volume) => volume.container),
          env: Object.fromEntries(draft.env.filter((entry) => entry.key).map((entry) => [entry.key, entry.value])),
          restart: draft.restart,
        },
      };
      const deployed = await dockerApi.deploy(payload);
      setResult(deployed);
      notify(`${draft.name} 部署成功`, 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setDeploying(false);
    }
  };

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
      {/* source selector */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-primary">
            <Globe className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">镜像源</div>
            <div className="text-[11px] text-muted-foreground">
              国内网络可切换镜像加速，模板元数据始终指向上游项目
            </div>
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

      {/* filters */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <span className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索应用"
              className="h-8 w-[200px] pl-8 text-[11.5px]"
              aria-label="搜索应用"
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
        </div>

        {visible.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Package} title="没有匹配的应用" description="换个关键词或分类试试。" />
          </div>
        ) : (
          <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((template) => (
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
                <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                  {template.ports.length > 0 ? (
                    <span className="truncate">端口 {template.ports.map((port) => port.host).join(', ')}</span>
                  ) : (
                    <span>无对外端口</span>
                  )}
                  {template.note ? <Badge tone="warning">注意</Badge> : null}
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </Card>

      {/* configure + deploy */}
      <Dialog
        open={selected !== null}
        onClose={() => {
          setSelected(null);
          setResult(null);
        }}
        title={result ? '部署完成' : `部署 ${selected?.name ?? ''}`}
        description={result ? undefined : selected?.description}
        className="max-w-[720px]"
        footer={
          result ? (
            <Button onClick={() => { setSelected(null); setResult(null); }}>完成</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setSelected(null)}>
                取消
              </Button>
              <Button disabled={deploying} onClick={() => void deploy()}>
                {deploying ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
                {deploying ? '正在部署…' : '开始部署'}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <DeployResultView result={result} />
        ) : draft ? (
          <div className="flex flex-col gap-4">
            {selected?.note ? (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning">
                {selected.note}
              </div>
            ) : null}

            {/* deployment mode */}
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
                      mode === value
                        ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]'
                        : 'border-border hover:bg-accent/50',
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
              <FormField label="镜像" hint={`实际拉取：${previewImage}`}>
                <Input value={draft.image} onChange={(event) => setDraft({ ...draft, image: event.target.value })} />
              </FormField>
            </div>

            {/* ports */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-foreground/85">端口映射</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({ ...draft, ports: [...draft.ports, { host: '', container: '', protocol: 'tcp' }] })
                  }
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
              </div>
            </div>

            {/* volumes */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-foreground/85">目录挂载</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      volumes: [...draft.volumes, { host: '', container: '', readOnly: false }],
                    })
                  }
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

function DeployResultView({ result }: { result: DeployResult }) {
  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2">
        <Check className="size-4 shrink-0 text-success" />
        <span>
          <strong>{result.name}</strong> 已通过 {result.mode === 'compose' ? 'docker compose' : 'docker run'} 启动
        </span>
      </div>
      <InfoRow label="镜像" value={result.image} mono />
      {result.containerId ? <InfoRow label="容器 ID" value={result.containerId} mono /> : null}
      {result.file ? <InfoRow label="compose 文件" value={result.file} mono /> : null}
      {result.command ? (
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">执行的命令</div>
          <pre className="overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10.5px]">
            {result.command}
          </pre>
        </div>
      ) : null}
      {result.yaml ? (
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">生成的 compose 文件</div>
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10.5px]">
            {result.yaml}
          </pre>
        </div>
      ) : null}
      {result.output ? (
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">输出</div>
          <pre className="max-h-32 overflow-auto rounded-lg border border-border bg-muted/40 p-2 font-mono text-[10.5px]">
            {result.output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] text-muted-foreground">{label}</div>
      <div className={cn('truncate rounded-md bg-muted/40 px-2 py-1.5', mono && 'font-mono text-[11px]')}>{value}</div>
    </div>
  );
}

/** Random password for required secrets, avoiding ambiguous characters. */
function generateSecret(length = 20): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}
