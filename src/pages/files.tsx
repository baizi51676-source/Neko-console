// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import { api, type FileEntry, type FileListing } from '@/lib/api';
import { formatBytes, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge, Button, Card } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

/**
 * File manager.
 *
 * The server enforces the root boundary; this page never constructs absolute
 * paths and always sends paths relative to the configured root, so the two sides
 * cannot disagree about where "here" is.
 */
export default function FilesPage() {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  const uploadInput = useRef<HTMLInputElement>(null);
  const toMessage = useApiError();
  const { notify } = useToast();

  const load = useCallback(
    async (path = '') => {
      setLoading(true);
      try {
        setListing(await api.files.list(path));
      } catch (error) {
        notify(toMessage(error), 'error');
      } finally {
        setLoading(false);
      }
    },
    [notify, toMessage],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const openEditor = async (entry: FileEntry) => {
    setEditorPath(entry.path);
    setEditorLoading(true);
    setDirty(false);
    try {
      const result = await api.files.read(entry.path);
      if (result.binary) {
        setEditorPath(null);
        notify('该文件是二进制格式，无法编辑', 'error');
        return;
      }
      setEditorValue(result.content ?? '');
    } catch (error) {
      setEditorPath(null);
      notify(toMessage(error), 'error');
    } finally {
      setEditorLoading(false);
    }
  };

  const saveEditor = async () => {
    if (editorPath === null) return;
    setBusy(true);
    try {
      await api.files.write(editorPath, editorValue);
      setDirty(false);
      notify('已保存', 'success');
      await load(listing?.path ?? '');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doUpload = async (file: File) => {
    if (!listing) return;
    const target = listing.path ? `${listing.path}/${file.name}` : file.name;
    setBusy(true);
    try {
      await api.files.upload(target, file);
      notify(`已上传 ${file.name}`, 'success');
      await load(listing.path);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(false);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.files.remove(deleteTarget.path);
      notify(`已删除 ${deleteTarget.name}`, 'success');
      setDeleteTarget(null);
      await load(listing?.path ?? '');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async () => {
    if (!mkdirName.trim()) return;
    const base = listing?.path ?? '';
    const target = base ? `${base}/${mkdirName.trim()}` : mkdirName.trim();
    setBusy(true);
    try {
      await api.files.mkdir(target);
      setMkdirOpen(false);
      setMkdirName('');
      notify('目录已创建', 'success');
      await load(base);
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Browser-level guard so a stray Ctrl+W does not silently discard edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  /* ---------------- editor view ---------------- */
  if (editorPath !== null) {
    return (
      <>
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
            <Button variant="ghost" size="sm" onClick={() => setEditorPath(null)}>
              <ArrowLeft className="size-3.5" /> 返回
            </Button>
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">{editorPath}</span>
            {dirty ? <Badge tone="warning">未保存</Badge> : null}
            <div className="flex-1" />
            <Button variant="outline" size="sm" disabled={busy || !dirty} onClick={() => void saveEditor()}>
              <Save className="size-3.5" /> 保存
            </Button>
          </div>
          {editorLoading ? (
            <div className="p-4">
              <div className="sk-shimmer h-64 rounded-lg" />
            </div>
          ) : (
            <textarea
              value={editorValue}
              onChange={(event) => {
                setEditorValue(event.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              className="min-h-[60vh] flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-relaxed outline-none"
            />
          )}
        </Card>
      </>
    );
  }

  /* ---------------- browser view ---------------- */
  const crumbs = (listing?.path ?? '').split('/').filter(Boolean);

  return (
    <>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={!listing?.parent && !listing?.path}
            onClick={() => {
              const parent = listing?.parent;
              void load(typeof parent === 'string' ? parent : '');
            }}
            title="上一级"
          >
            <ArrowLeft className="size-3.5" />
          </Button>

          {/* breadcrumb: each segment navigates to that level */}
          <div className="flex min-w-0 items-center gap-0.5 text-[12px]">
            <button
              type="button"
              onClick={() => void load('')}
              className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              /
            </button>
            {crumbs.map((segment, index) => {
              const path = crumbs.slice(0, index + 1).join('/');
              return (
                <span key={path} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void load(path)}
                    className="max-w-[160px] truncate rounded px-1.5 py-0.5 transition-colors hover:bg-accent"
                  >
                    {segment}
                  </button>
                  {index < crumbs.length - 1 ? <span className="text-muted-foreground">/</span> : null}
                </span>
              );
            })}
          </div>

          <div className="flex-1" />

          <input
            ref={uploadInput}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void doUpload(file);
            }}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}>
            <Upload className="size-3.5" /> 上传
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setMkdirOpen(true)}>
            <FolderPlus className="size-3.5" /> 新建目录
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load(listing?.path ?? '')}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>

        {listing === null || (loading && listing.items.length === 0) ? (
          <div className="p-4">
            <div className="sk-shimmer h-40 rounded-lg" />
          </div>
        ) : listing.items.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={Folder}
              title="这个目录是空的"
              description="可以上传文件或新建子目录。"
              action={
                <Button size="sm" onClick={() => uploadInput.current?.click()}>
                  <Upload className="size-3.5" /> 上传文件
                </Button>
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {listing.items.map((entry) => (
              <div key={entry.path} className="group flex items-center gap-3 px-4 py-2 hover:bg-accent/30">
                <span
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-md',
                    entry.type === 'dir' ? 'bg-[var(--accent-soft)] text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {entry.type === 'dir' ? (
                    <Folder className="size-3.5" />
                  ) : entry.type === 'link' ? (
                    <Link2 className="size-3.5" />
                  ) : (
                    <FileIcon className="size-3.5" />
                  )}
                </span>

                <button
                  type="button"
                  onClick={() => {
                    if (entry.type === 'dir') void load(entry.path);
                    else if (entry.type === 'file') void openEditor(entry);
                  }}
                  className="min-w-0 flex-1 text-left"
                  disabled={entry.escapes}
                >
                  <div className="truncate text-[12.5px] font-medium">{entry.name}</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    {entry.type === 'dir' ? '目录' : formatBytes(entry.size)}
                    {entry.mode ? ` · ${entry.mode}` : ''}
                    {entry.modified ? ` · ${formatTime(entry.modified)}` : ''}
                  </div>
                </button>

                {entry.escapes ? <Badge tone="destructive">指向外部</Badge> : null}

                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {entry.type === 'file' ? (
                    <>
                      <Button variant="ghost" size="sm" title="编辑" onClick={() => void openEditor(entry)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <a
                        href={api.files.downloadUrl(entry.path)}
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                        title="下载"
                      >
                        <Download className="size-3.5" />
                      </a>
                    </>
                  ) : null}
                  <Button variant="ghost" size="sm" title="删除" onClick={() => setDeleteTarget(entry)}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          {listing?.items.length ?? 0} 项 · 根目录由服务端配置（fileRoot），无法越界访问
        </div>
      </Card>

      {/* new folder */}
      <Dialog
        open={mkdirOpen}
        onClose={() => setMkdirOpen(false)}
        title="新建目录"
        description={listing?.path ? `在 ${listing.path} 下创建` : '在根目录下创建'}
        footer={
          <>
            <Button variant="outline" onClick={() => setMkdirOpen(false)}>
              取消
            </Button>
            <Button disabled={!mkdirName.trim() || busy} onClick={() => void createFolder()}>
              创建
            </Button>
          </>
        }
      >
        <Input
          value={mkdirName}
          onChange={(event) => setMkdirName(event.target.value)}
          placeholder="目录名"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void createFolder();
          }}
        />
      </Dialog>

      {/* delete confirm */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
        description={
          deleteTarget?.type === 'dir'
            ? '目录及其全部内容将被永久删除，此操作不可撤销。'
            : '文件将被永久删除，此操作不可撤销。'
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              删除
            </Button>
          </>
        }
      >
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[12px]">
          {deleteTarget?.path}
        </div>
      </Dialog>
    </>
  );
}
