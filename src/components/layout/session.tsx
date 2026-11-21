// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, UnauthorizedError, api } from '@/lib/api';

/**
 * Session state, backed by the server's signed cookie.
 *
 * Deliberately no credentials in localStorage: the server sets an HttpOnly
 * cookie, so this layer only tracks *whether* we are authenticated. On boot it
 * asks the server rather than trusting a local flag, which means revoking a
 * session server-side takes effect on the next page load.
 */

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface SessionContextValue {
  status: SessionStatus;
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Called by API consumers when any request returns 401. */
  expire: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [username, setUsername] = useState<string | null>(null);

  // Probe the cookie on mount; the shell shows a splash until this settles so
  // the login form does not flash for an already-authenticated user.
  useEffect(() => {
    let cancelled = false;
    api.auth
      .session()
      .then((result) => {
        if (cancelled) return;
        if (result.authenticated) {
          setUsername(result.username ?? null);
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (user: string, password: string) => {
    await api.auth.login(user, password);
    setUsername(user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      setUsername(null);
      setStatus('anonymous');
    }
  }, []);

  const expire = useCallback(() => {
    setUsername(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ status, username, login, logout, expire }),
    [status, username, login, logout, expire],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Normalise any thrown error for display, and route 401s to the session layer.
 *
 * Pages use this instead of catching `ApiError` themselves, so an expired cookie
 * consistently bounces to the login screen from anywhere in the app.
 */
export function useApiError(): (error: unknown) => string {
  const { expire } = useSession();
  return useCallback(
    (error: unknown) => {
      if (error instanceof UnauthorizedError) {
        expire();
        return error.message;
      }
      if (error instanceof ApiError) return error.message;
      return error instanceof Error ? error.message : '未知错误';
    },
    [expire],
  );
}
