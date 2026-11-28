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
  constructor(
    message: string,
    readonly status: number,
    /** Stable machine code (e.g. `DOCKER_PORT_CONFLICT`); branch on this. */
    readonly code?: string,
    /** Raw upstream cause (docker stderr, validation hint) for disclosure. */
    readonly detail?: string,
  ) {
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
  code?: string;
  detail?: string;
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
    throw new ApiError(
      payload.error ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      payload.code,
      payload.detail,
    );
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

/* ------------------------------------------------------------------ */
/* docker                                                              */
/* ------------------------------------------------------------------ */

export interface ContainerStats {
  cpu: number;
  memory: number;
  memoryPercent: number;
  net: string;
  block: string;
  pids: number;
}

export interface ContainerPort {
  containerPort: number;
  hostPort: number | null;
  hostIp: string | null;
  protocol: string;
}

export interface ContainerMount {
  type: string;
  source: string;
  destination: string;
  mode: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  runningFor: string;
  ports: string;
  composeProject: string | null;
  composeService: string | null;
  health?: string | null;
  restartPolicy?: string;
  portsDetailed?: ContainerPort[];
  mounts?: ContainerMount[];
  env?: { key: string; value: string }[];
  command?: string;
  stats?: ContainerStats | null;
}

export interface DockerStack {
  name: string;
  running: number;
  total: number;
  services: { name: string; container: string; state: string; status: string }[];
  workingDir: string | null;
  configFile: string | null;
}

export interface DockerStatus {
  available: boolean;
  reason?: string;
  version?: string;
  compose?: string | null;
  containers: Container[];
  stacks: DockerStack[];
  images: { id: string; repository: string; tag: string; size: string; createdSince: string }[];
  volumes: { name: string; driver: string; mountpoint: string }[];
  networks: { id: string; name: string; driver: string; scope: string }[];
  usage: Record<string, unknown>[] | null;
}

export interface RegistrySource {
  id: string;
  label: string;
  hint: string;
  imagePrefix: string;
}

export interface TemplatePort {
  host: number;
  container: number;
  protocol?: string;
  label?: string;
}

export interface TemplateVariable {
  key: string;
  label: string;
  default?: string;
  secret?: boolean;
  required?: boolean;
  hint?: string;
}

export interface AppTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  image: string;
  ports: TemplatePort[];
  volumes: { host: string; container: string; readOnly?: boolean }[];
  env: TemplateVariable[];
  extraArgs?: string[];
  homepage?: string;
  docs?: string;
  note?: string;
}

export interface DeployResult {
  /** Present on the immediate response; the job streams the real outcome. */
  jobId?: string;
  mode: 'run' | 'compose';
  name: string;
  image: string;
  command?: string;
  file?: string;
  yaml?: string;
  pullOutput?: string;
  output?: string;
  containerId?: string;
}

export interface PowerState {
  available: boolean;
  canReboot: boolean;
  canShutdown: boolean;
  countdown: number;
  reason?: string;
  pending: { token: string; action: string; firesAt: number; remaining: number }[];
}

export interface PowerSchedule {
  token: string;
  action: string;
  firesAt: number;
  countdown: number;
  message: string;
}

export const dockerApi = {
  status: () => get<DockerStatus>('/api/docker/status'),
  containers: () => get<{ containers: Container[] }>('/api/docker/containers'),
  logs: (name: string, lines = 300) =>
    get<{ available: boolean; lines: { index: number; raw: string }[] }>(
      `/api/docker/logs?name=${encodeURIComponent(name)}&lines=${lines}`,
    ),
  action: (name: string, action: string) => post<{ action: string; name: string }>('/api/docker/action', { name, action }),
  remove: (name: string, force = false) => post<{ name: string }>('/api/docker/remove', { name, force }),
  stack: (name: string, action: string) => post<{ ok: boolean; output?: string }>('/api/docker/stack', { name, action }),
  catalog: () => get<{ templates: AppTemplate[]; sources: RegistrySource[] }>('/api/docker/catalog'),
  deploy: (payload: Record<string, unknown>) => post<DeployResult>('/api/docker/deploy', payload),
  projects: () => get<{ projects: { name: string; file: string }[] }>('/api/docker/projects'),
  project: (name: string) => get<{ name: string; file: string; yaml: string }>(`/api/docker/project?name=${encodeURIComponent(name)}`),
  saveProject: (name: string, yaml: string) => post<{ ok: boolean; file: string }>('/api/docker/project', { name, yaml }),
  /* ---- deployment jobs ---- */

  job: (id: string, since = 0) => get<DeployJob>(`/api/docker/job?id=${encodeURIComponent(id)}&since=${since}`),
  jobs: () => get<{ jobs: DeployJobSummary[] }>('/api/docker/jobs'),
  cancelJob: (id: string) => post<{ cancelled: boolean }>('/api/docker/job/cancel', { id }),

  /* ---- repository discovery ---- */

  search: (query: string, limit = 12) =>
    get<{ results: RepoResult[]; query: string }>(`/api/docker/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  analyze: (url: string, ref?: string) => post<RepoAnalysis>('/api/docker/analyze', { url, ref }),
  readme: (repo: string) =>
    get<{ summary: string; raw: string; path: string | null }>(`/api/docker/readme?repo=${encodeURIComponent(repo)}`),

  /* ---- container reconfiguration ---- */

  containerConfig: (name: string) =>
    get<{ config: ContainerConfig; usedPorts: { port: number; owner: string }[] }>(
      `/api/docker/container/config?name=${encodeURIComponent(name)}`,
    ),
  updatePorts: (name: string, ports: { host: number | null; container: number; protocol: string }[]) =>
    post<{ jobId: string }>('/api/docker/container/ports', { name, ports }),
  updateRestartPolicy: (name: string, policy: string) =>
    post<{ ok: boolean; policy: string }>('/api/docker/container/restart-policy', { name, policy }),
};

export const powerApi = {
  state: () => get<PowerState>('/api/power'),
  schedule: (action: 'reboot' | 'shutdown', password: string) =>
    post<PowerSchedule>('/api/power', { action, password }),
  cancel: (token: string) => post<{ cancelled: boolean }>('/api/power/cancel', { token }),
};
/* ------------------------------------------------------------------ */
/* deployment jobs                                                     */
/* ------------------------------------------------------------------ */

export interface DeployJobLogLine {
  seq: number;
  level: 'info' | 'stream' | 'success' | 'warn' | 'error' | string;
  message: string;
  at: number;
}

export interface DeployJobSummary {
  id: string;
  name: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  errorCode: string | null;
  lines: number;
}

export interface DeployJob extends DeployJobSummary {
  log: DeployJobLogLine[];
  lastSeq: number;
  result: (DeployResult & Record<string, unknown>) | null;
}

/** A repository discovered by live search. */
export interface RepoResult {
  id: string;
  name: string;
  fullName: string;
  repo: string;
  description: string;
  stars: number;
  topics: string[];
  updatedAt: string;
  htmlUrl: string;
  license: string | null;
  source: 'github';
}

/** Result of analysing an arbitrary repository. */
export interface RepoAnalysis {
  kind: 'compose' | 'dockerfile' | 'unknown';
  repo: string;
  ref: string;
  path?: string;
  meta: {
    name?: string;
    description?: string | null;
    defaultBranch?: string;
    stars?: number | null;
    license?: string | null;
    archived?: boolean;
    htmlUrl?: string;
    warning?: string;
  };
  image: string | null;
  ports: TemplatePort[];
  env: Record<string, string>;
  description: string;
  readme: string;
  compose?: string;
  dockerfile?: string;
  serviceName?: string;
  note?: string;
  composeSource?: string;
}

/** Mutable container config used by the port editor. */
export interface ContainerConfig {
  name: string;
  image: string;
  ports: { host: number | null; container: number; protocol: string; hostIp: string | null }[];
  env: { key: string; value: string }[];
  mounts: { type: string; source: string; destination: string; readOnly: boolean }[];
  restartPolicy: string;
  networkMode: string;
  state: string;
}

Object.assign(dockerApi, {
  search: (query: string, limit = 12) =>
    get<{ results: RepoResult[]; query: string }>(`/api/docker/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  analyze: (url: string, ref?: string) =>
    post<RepoAnalysis>('/api/docker/analyze', { url, ref }),
  readme: (repo: string) =>
    get<{ summary: string; raw: string; path: string | null }>(`/api/docker/readme?repo=${encodeURIComponent(repo)}`),
  job: (id: string, since = 0) => get<DeployJob>(`/api/docker/job?id=${encodeURIComponent(id)}&since=${since}`),
  jobs: () => get<{ jobs: DeployJobSummary[] }>('/api/docker/jobs'),
  cancelJob: (id: string) => post<{ cancelled: boolean }>('/api/docker/job/cancel', { id }),
  containerConfig: (name: string) =>
    get<{ config: ContainerConfig; usedPorts: { port: number; owner: string }[] }>(
      `/api/docker/container/config?name=${encodeURIComponent(name)}`,
    ),
  updatePorts: (name: string, ports: { host: number | null; container: number; protocol: string }[]) =>
    post<{ jobId: string }>('/api/docker/container/ports', { name, ports }),
  updateRestartPolicy: (name: string, policy: string) =>
    post<{ ok: boolean; policy: string }>('/api/docker/container/restart-policy', { name, policy }),
});
/* ------------------------------------------------------------------ */
/* panel: sites / certificates / databases / jobs / backups            */
/* ------------------------------------------------------------------ */

export interface SiteRow {
  id: string;
  name: string;
  kind: 'static' | 'proxy';
  server_names: string;
  upstream: string | null;
  root_path: string | null;
  indexed: number;
  ssl: number;
  cert_name: string | null;
  created_at: string;
  updated_at: string;
  rendered?: boolean;
}

export interface NginxStatus {
  available: boolean;
  version: string;
  running: boolean;
  managedDir: string;
  wired: boolean;
}

export interface CertificateRow {
  lineage: string;
  path: string;
  subject: string;
  altNames: string[];
  expiresAt: string;
  issuedAt: string | null;
  daysLeft: number;
  expiringSoon: boolean;
  expired: boolean;
}

export interface CertificateHealth {
  certificates: CertificateRow[];
  total: number;
  expiringCount: number;
  expiredCount: number;
  warnDays: number;
  timer: { installed: boolean; enabled: boolean; next: string | null };
}

export interface DbEngine {
  id: string;
  label: string;
  available: boolean;
  version?: string | null;
  hint: string | null;
}

export interface JobRow {
  id: number;
  name: string;
  schedule: string;
  command: string;
  kind: string;
  enabled: number;
  last_run: string | null;
  last_status: string | null;
  created_at: string;
  runs?: JobRun[];
}

export interface JobRun {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  output: string | null;
}

export interface BackupRow {
  id: number;
  kind: 'database' | 'site';
  label: string;
  path: string;
  size: number;
  sha256: string | null;
  created_at: string;
}

export interface AuditRow {
  id: number;
  at: string;
  action: string;
  target: string | null;
  detail: string | null;
  result: string;
}

export interface PanelStatus {
  nginx: NginxStatus;
  certificates: CertificateHealth;
  databases: DbEngine[];
  sites: number;
  actions: { name: string; description: string }[];
}

export const panelApi = {
  status: () => get<PanelStatus>('/api/panel/status'),

  sites: () => get<{ sites: SiteRow[]; managedFiles: { name: string; path: string; size: number }[] }>('/api/sites'),
  sitePreview: (id: string) => get<{ config: string }>(`/api/sites/preview?id=${encodeURIComponent(id)}`),
  siteTest: () => get<{ ok: boolean; output: string }>('/api/sites/test'),
  bootstrapSites: () => post<{ created: boolean; dir: string; include: string }>('/api/sites/bootstrap'),
  createSite: (payload: Record<string, unknown>) => post<{ site: SiteRow }>('/api/sites', payload),
  updateSite: (payload: Record<string, unknown>) => post<{ site: SiteRow }>('/api/sites/update', payload),
  deleteSite: (id: string) => post<{ deleted: boolean }>('/api/sites/delete', { id }),

  certificates: () => get<CertificateHealth>('/api/certificates'),
  issueCertificate: (domains: string[]) => post<CertificateRow & { output: string }>('/api/certificates/issue', { domains }),
  renewCertificate: (lineage: string) => post<{ ok: boolean; output: string }>('/api/certificates/renew', { lineage }),
  installCertTimer: () => post<{ service: string; timer: string }>('/api/certificates/timer'),

  engines: () => get<{ engines: DbEngine[] }>('/api/databases/engines'),
  listDatabases: (engine: string) =>
    get<{ engine: string; databases: string[] }>(`/api/databases/list?engine=${encodeURIComponent(engine)}`),
  createDatabase: (payload: Record<string, unknown>) =>
    post<{ engine: string; database: string; username: string; password: string }>('/api/databases/create', payload),
  dropDatabase: (payload: Record<string, unknown>) => post<{ dropped: boolean }>('/api/databases/drop', payload),

  jobs: () => get<{ jobs: JobRow[]; actions: { name: string; description: string }[]; scripts: string[] }>('/api/jobs'),
  createJob: (payload: Record<string, unknown>) => post<{ job: JobRow }>('/api/jobs', payload),
  updateJob: (payload: Record<string, unknown>) => post<{ job: JobRow }>('/api/jobs/update', payload),
  deleteJob: (id: number) => post<{ deleted: boolean }>('/api/jobs/delete', { id }),
  runJob: (id: number) => post<{ ok: boolean; output?: string; error?: string }>('/api/jobs/run', { id }),

  backups: () => get<{ entries: BackupRow[]; totalSize: number; keep: number; dir: string }>('/api/backups'),
  runBackup: (payload: Record<string, unknown>) =>
    post<{ files?: { kind: string; label: string; size: number }[]; totalSize?: number; path?: string; size?: number; sha256?: string }>(
      '/api/backups/run',
      payload,
    ),
  verifyBackup: (path: string) => post<{ ok: boolean; expected?: string; actual?: string; reason?: string }>('/api/backups/verify', { path }),
  pruneBackups: () => post<{ removed: string[] }>('/api/backups/prune'),

  audit: (limit = 100) => get<{ entries: AuditRow[] }>(`/api/audit?limit=${limit}`),
};