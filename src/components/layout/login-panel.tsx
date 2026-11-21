// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useState } from 'react';
import { motion } from 'motion/react';
import { Activity, AlertCircle, Eye, EyeOff, Loader2, LogIn, ShieldCheck, Terminal } from 'lucide-react';
import { APP_CONFIG } from '@/config/app-config';
import { useTheme } from '@/lib/theme-provider';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { BrandMark } from './brand-mark';
import { useSession } from './session';

/**
 * Login screen.
 *
 * Split panel on desktop, single column on mobile. The left panel states what
 * the console is and how it is secured, which matters more here than decoration:
 * this is a tool that can restart services and edit files.
 */
export function LoginPanel() {
  const { theme } = useTheme();
  const { login } = useSession();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const brandTitle = theme.brand?.title || APP_CONFIG.name;
  const brandSubtitle = theme.brand?.subtitle || APP_CONFIG.subtitle;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const highlights = [
    { icon: Activity, text: 'CPU、内存、磁盘与网络的实时监控，SSE 推送' },
    { icon: Terminal, text: 'systemd 服务启停、进程查看、日志与文件管理' },
    { icon: ShieldCheck, text: 'scrypt 口令哈希、HttpOnly 签名会话、登录限流' },
  ];

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden p-5">
      <div
        className="pointer-events-none absolute -left-28 -top-36 size-[420px] rounded-full"
        style={{ background: 'radial-gradient(closest-side, var(--primary), transparent)', opacity: 0.18 }}
      />
      <div
        className="pointer-events-none absolute -bottom-44 -right-28 size-[380px] rounded-full"
        style={{ background: 'radial-gradient(closest-side, var(--primary), transparent)', opacity: 0.12 }}
      />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="relative w-full max-w-[860px] overflow-hidden rounded-3xl border border-border bg-card shadow-2xl md:grid md:grid-cols-[1.02fr_1fr]"
      >
        <div className="hidden flex-col justify-between gap-8 border-r border-border p-8 md:flex">
          <div>
            <div className="flex items-center gap-2.5">
              <BrandMark size={40} />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold leading-tight">{brandTitle}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">{brandSubtitle}</div>
              </div>
            </div>
            <h1 className="mt-7 text-[22px] font-semibold leading-snug tracking-tight">服务器控制台</h1>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{APP_CONFIG.tagline}</p>
          </div>
          <ul className="flex flex-col gap-2.5 text-xs text-muted-foreground">
            {highlights.map((item) => (
              <li key={item.text} className="flex items-start gap-2">
                <item.icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="leading-relaxed">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="p-6 md:p-8">
          <div className="mb-5 flex items-center gap-2.5 md:hidden">
            <BrandMark size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight">{brandTitle}</div>
              <div className="truncate text-[11px] text-muted-foreground">{brandSubtitle}</div>
            </div>
          </div>

          <h2 className="text-[17px] font-semibold tracking-tight">登录</h2>
          <p className="mb-5 mt-1 text-xs text-muted-foreground">使用服务器管理员账号登录</p>

          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field label="用户名">
              <Input value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
            </Field>

            <Field label="密码">
              <span className="flex items-center gap-2">
                <Input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setReveal((value) => !value)}
                  aria-label={reveal ? '隐藏密码' : '显示密码'}
                >
                  {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </span>
            </Field>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span className="leading-relaxed">{error}</span>
              </div>
            ) : null}

            <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
              {busy ? '正在登录…' : '登录'}
            </Button>
          </form>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            会话保存在 HttpOnly Cookie 中，关闭浏览器或超时后需重新登录。
          </p>
        </div>
      </motion.div>
    </div>
  );
}
