// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Power, RotateCw, X } from 'lucide-react';
import { powerApi, type PowerSchedule, type PowerState } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { useApiError } from '@/components/layout/session';
import { useToast } from '@/components/ui/toast';

/**
 * Host power control.
 *
 * Deliberately requires the account password even though the session is already
 * authenticated: a single mis-click must not be able to take the server down, and
 * a stolen session cookie must not be enough either. A countdown follows so the
 * action can still be called off.
 */
export function PowerMenu() {
  const [state, setState] = useState<PowerState | null>(null);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'reboot' | 'shutdown' | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState<PowerSchedule | null>(null);
  const [remaining, setRemaining] = useState(0);

  const toMessage = useApiError();
  const { notify } = useToast();

  useEffect(() => {
    powerApi.state().then(setState).catch(() => setState(null));
  }, []);

  // Tick the visible countdown while an action is pending.
  useEffect(() => {
    if (!schedule) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((schedule.firesAt - Date.now()) / 1000));
      setRemaining(left);
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [schedule]);

  const submit = useCallback(async () => {
    if (!action || !password) return;
    setBusy(true);
    try {
      const result = await powerApi.schedule(action, password);
      setSchedule(result);
      setRemaining(result.countdown);
      setOpen(false);
      setPassword('');
      notify(result.message, 'success');
    } catch (error) {
      notify(toMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [action, password, notify, toMessage]);

  const cancel = useCallback(async () => {
    if (!schedule) return;
    try {
      const result = await powerApi.cancel(schedule.token);
      if (result.cancelled) {
        notify('已取消关机/重启', 'success');
        setSchedule(null);
      } else {
        notify('操作已执行或已过期', 'error');
        setSchedule(null);
      }
    } catch (error) {
      notify(toMessage(error), 'error');
    }
  }, [schedule, notify, toMessage]);

  const available = state?.available ?? false;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="电源操作"
        title="重启 / 关机"
        disabled={!available}
        onClick={() => setOpen(true)}
      >
        <Power className="size-4" />
      </Button>

      {/* pending banner */}
      {schedule ? (
        <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10.5px] text-destructive">
          <span className="tabular-nums">{remaining}s</span>
          <span className="truncate">{schedule.action === 'reboot' ? '后重启' : '后关机'}</span>
          <button type="button" onClick={() => void cancel()} aria-label="取消" className="ml-auto shrink-0 hover:opacity-70">
            <X className="size-3" />
          </button>
        </div>
      ) : null}

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setAction(null);
          setPassword('');
        }}
        title="电源操作"
        description="选择要执行的操作。需要输入密码确认，并可在倒计时内取消。"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                setAction(null);
                setPassword('');
              }}
            >
              取消
            </Button>
            <Button
              variant={action === 'shutdown' ? 'destructive' : 'primary'}
              disabled={!action || !password || busy}
              onClick={() => void submit()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : action === 'shutdown' ? <Power className="size-3.5" /> : <RotateCw className="size-3.5" />}
              确认{action === 'shutdown' ? '关机' : action === 'reboot' ? '重启' : ''}
            </Button>
          </>
        }
      >
        {!available ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
            {state?.reason ?? '该系统不支持电源操作'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAction('reboot')}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors',
                  action === 'reboot' ? 'border-[var(--accent-line)] bg-[var(--accent-soft)]' : 'border-border hover:bg-accent/50',
                )}
              >
                <RotateCw className="size-5" />
                <span className="text-[12px] font-medium">重启</span>
                <span className="text-[10px] text-muted-foreground">systemctl reboot</span>
              </button>
              <button
                type="button"
                onClick={() => setAction('shutdown')}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors',
                  action === 'shutdown'
                    ? 'border-destructive/50 bg-destructive/10'
                    : 'border-border hover:bg-accent/50',
                )}
              >
                <Power className={cn('size-5', action === 'shutdown' && 'text-destructive')} />
                <span className="text-[12px] font-medium">关机</span>
                <span className="text-[10px] text-muted-foreground">systemctl poweroff</span>
              </button>
            </div>

            <Field label="当前账号密码" hint="用于确认这是你本人的操作">
              <Input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
                placeholder="输入密码以确认"
              />
            </Field>

            {action === 'shutdown' ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  关机后服务器将完全离线，必须通过云服务商控制台才能重新开机。确认倒计时 {state?.countdown ?? 20} 秒。
                </span>
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                重启会中断当前所有连接，包括这个控制台页面。倒计时 {state?.countdown ?? 20} 秒内可在侧边栏取消。
              </p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
