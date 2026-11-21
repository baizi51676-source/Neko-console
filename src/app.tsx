// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { Loader2 } from 'lucide-react';
import { ThemeProvider } from '@/lib/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { SessionProvider, useSession } from '@/components/layout/session';
import { LoginPanel } from '@/components/layout/login-panel';
import { Shell, useHashRoute } from '@/components/layout/shell';

/**
 * App root — composes the providers and decides login vs. shell.
 *
 * Provider order matters: theme and toasts wrap the session gate so the login
 * screen is already themed and can show errors. The gate waits for the session
 * probe to settle, otherwise an authenticated reload would flash the login form.
 */
function Gate() {
  const { status } = useSession();
  const [page, navigate] = useHashRoute();

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> 正在连接服务器…
        </span>
      </div>
    );
  }

  if (status === 'anonymous') return <LoginPanel />;
  return <Shell page={page} navigate={navigate} />;
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
