// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

/**
 * API client.
 *
 * Every response shares one envelope (`{ ok, data | error }`), so a single
 * helper can both unwrap results and turn failures into thrown errors with the
 * server's own message. A 401 is surfaced as a distinct class because the
 * session layer has to react to it (drop to the login screen) instead of showing
 * a toast.
 */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the session expired; the app routes this to the login screen. */
export class UnauthorizedError extends ApiError {
  constructor(message = '登录已过期，请重新登录') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (response.status === 401) throw new UnauthorizedError();

  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`响应不是 JSON（HTTP ${response.status}）`, response.status);
  }

  if (!response.ok || !payload.ok) {
    throw new ApiError(payload.error ?? `请求失败（HTTP ${response.status}）`, response.status);
  }
  return payload.data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/* ------------------------------------------------------------------ */
/* shapes                                                              */
/* ------------------------------------------------------------------ */

export interface CpuInfo {
  usage: number;
  load: [number, number, number];
  loadPercent: number;
  cores: number;
  model: string;
  mhz: number;
  temperature: number | null;
}

export interface MemoryInfo {
  total: number;
  used: number;
  free: number;
  available: number;
  buffers: number;
  cached: number;
  swapTotal: number;
  swapUsed: number;
  percent: number;
}

export interface DiskInfo {
  filesystem: string;
  size: number;
  used: number;
  available: number;
  percent: number;
  mount: string;
}

export interface NetInterface {
  name: string;
  rx: number;
  tx: number;
  rxRate: number;
  txRate: number;
}

export interface HostInfo {
  hostname: string;
  distro: string;
  kernel: string;
  arch: string;
  uptime: number;
  bootTime: number;
  virtualization: string | null;
}

export interface Overview {
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  network: NetInterface[];
  host: HostInfo;
  timestamp: number;
}

export interface ProcessRow {
  pid: number;
  name: string;
  command: string;
  state: string;
  cpu: number;
  memory: number;
  memoryPercent: number;
  threads: number;
  uid: number;
  started: number;
}

export interface ServiceUnit {
  name: string;
  fullName: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export interface LogLine {
  index: number;
  time: string | null;
  host: string | null;
  source: string | null;
  message: string;
  raw: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  modified: string | null;
  mode: string | null;
  escapes: boolean;
}

export interface FileListing {
  path: string;
  parent: string | null;
  items: FileEntry[];
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

export const api = {
  auth: {
    session: () => get<{ authenticated: boolean; username?: string }>('/api/auth/session'),
    login: (username: string, password: string) => post<{ username: string }>('/api/auth/login', { username, password }),
    logout: () => post<Record<string, never>>('/api/auth/logout'),
  },

  metrics: {
    overview: () => get<Overview>('/api/overview'),
    cpu: () => get<CpuInfo>('/api/cpu'),
    memory: () => get<MemoryInfo>('/api/memory'),
    disks: () => get<{ disks: DiskInfo[]; mounts: unknown[] }>('/api/disks'),
    network: () => get<{ interfaces: NetInterface[]; sessions: unknown[] }>('/api/network'),
    host: () => get<HostInfo>('/api/host'),
  },

  processes: {
    list: () => get<{ processes: ProcessRow[] }>('/api/processes'),
    detail: (pid: number) => get<Record<string, unknown>>(`/api/processes/detail?pid=${pid}`),
  },

  services: {
    list: (refresh = false) => get<{ available: boolean; units: ServiceUnit[] }>(`/api/services${refresh ? '?refresh=1' : ''}`),
    action: (unit: string, action: string) => post<{ ok: boolean }>('/api/services/action', { unit, action }),
    logs: (unit: string, lines = 200) =>
      get<{ available: boolean; lines: LogLine[] }>(`/api/services/logs?unit=${encodeURIComponent(unit)}&lines=${lines}`),
  },

  logs: {
    files: () => get<{ files: { path: string; size: number; modified: string }[] }>('/api/logs/files'),
    read: (path: string, lines = 300) =>
      get<{ available: boolean; lines: LogLine[]; size?: number }>(
        `/api/logs/read?path=${encodeURIComponent(path)}&lines=${lines}`,
      ),
    journal: (lines = 300, priority = 'all') =>
      get<{ available: boolean; lines: LogLine[] }>(`/api/logs/journal?lines=${lines}&priority=${priority}`),
  },

  files: {
    list: (path = '') => get<FileListing>(`/api/files?path=${encodeURIComponent(path)}`),
    read: (path: string) => get<{ binary: boolean; size: number; content: string | null }>(
      `/api/files/read?path=${encodeURIComponent(path)}`,
    ),
    write: (path: string, content: string) => post<{ ok: boolean; size: number }>('/api/files/write', { path, content }),
    mkdir: (path: string) => post<{ ok: boolean }>('/api/files/mkdir', { path }),
    remove: (path: string) => post<{ ok: boolean }>('/api/files/delete', { path }),
    rename: (from: string, to: string) => post<{ ok: boolean }>('/api/files/rename', { from, to }),
    /** Uploads use a raw body, not JSON, so the server can stream straight to disk. */
    upload: async (path: string, file: File) => {
      const response = await fetch(`/api/files/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      if (response.status === 401) throw new UnauthorizedError();
      const payload = (await response.json()) as Envelope<{ ok: boolean; size: number }>;
      if (!payload.ok) throw new ApiError(payload.error ?? '上传失败', response.status);
      return payload.data!;
    },
    downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
  },
};

/**
 * Subscribe to live metrics.
 *
 * EventSource cannot send custom headers, but the session is cookie-based, so it
 * authenticates transparently. `onError` is called with the ready state so the
 * caller can distinguish a transient drop from a closed session.
 */
export function subscribeMetrics(
  onData: (overview: Overview) => void,
  onError?: (event: Event) => void,
): () => void {
  const source = new EventSource('/api/stream', { withCredentials: true });

  source.onmessage = (event) => {
    try {
      onData(JSON.parse(event.data) as Overview);
    } catch {
      /* a malformed frame is dropped; the next one will arrive in 2s */
    }
  };
  if (onError) source.onerror = onError;

  return () => source.close();
}
