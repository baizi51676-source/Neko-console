/**
 * Docker inspection and control.
 *
 * Talks to the Docker CLI rather than the Engine HTTP API directly. The CLI is
 * already installed wherever Docker is, and it normalises API-version differences
 * between daemons — speaking raw HTTP would mean pinning an API version and
 * breaking on older hosts. All output is requested as JSON (`--format '{{json …}}'`)
 * so we never parse human-formatted tables.
 *
 * Every function degrades to an empty result plus a reason when Docker is
 * missing or unreachable, so the UI can explain *why* instead of erroring.
 */
import { ApiError } from '../errors.mjs';
import { hasBinary, isSafeToken, round, tryRun } from '../util.mjs';

/** Container name / id / image reference character set. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ID_RE = /^[a-f0-9]{4,64}$/;

/**
 * Whether the Docker CLI exists and the daemon answers.
 * @returns {Promise<{ available: boolean, reason?: string, version?: string, compose?: string }>}
 */
export async function getDockerStatus() {
  if (!hasBinary('docker')) {
    return { available: false, reason: '未安装 Docker' };
  }
  const version = await tryRun('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 6000 });
  if (version === null) {
    // Distinguish "daemon down" from "permission denied" — the fixes differ,
    // and a bare failure message leaves the user guessing.
    const probe = await tryRun('docker', ['info'], { timeout: 6000 });
    if (probe === null) {
      const detail = await tryRun('sh', ['-c', 'docker info 2>&1'], { timeout: 6000 });
      const text = (detail ?? '').toLowerCase();
      if (text.includes('permission denied')) {
        return { available: false, reason: '当前用户无权访问 Docker（需加入 docker 组）' };
      }
      return { available: false, reason: 'Docker 守护进程未运行' };
    }
  }
  const compose = await tryRun('docker', ['compose', 'version', '--short'], { timeout: 6000 });
  return {
    available: true,
    version: (version ?? '').trim() || 'unknown',
    compose: (compose ?? '').trim() || null,
  };
}

/**
 * Run a docker command and parse one JSON object per line.
 *
 * `--format '{{json .}}'` emits newline-delimited JSON, which tolerates the
 * fact that container names and labels may contain awkward characters.
 */
async function dockerJson(args, timeout = 15000) {
  const out = await tryRun('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  if (out === null) return [];
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* non-JSON line (a warning printed to stdout) — skip */
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* containers                                                          */
/* ------------------------------------------------------------------ */

/**
 * All containers, running or not.
 *
 * `docker ps -a --format` gives us the common fields; ports and mounts come from
 * a second `docker inspect` pass for the containers we actually return, because
 * ps truncates port mappings and cannot show volume details at all.
 */
export async function listContainers() {
  const rows = await dockerJson([
    'ps', '-a',
    '--format', '{{json .}}',
  ]);
  if (rows.length === 0) return [];

  const containers = rows.map((row) => {
    const ports = String(row.Ports ?? '');
    return {
      id: String(row.ID ?? ''),
      name: String(row.Names ?? ''),
      image: String(row.Image ?? ''),
      state: String(row.State ?? '').toLowerCase(),
      status: String(row.Status ?? ''),
      created: String(row.CreatedAt ?? ''),
      runningFor: String(row.RunningFor ?? ''),
      ports,
      // Compose stamps these labels on every container it creates; they are how
      // the UI groups containers into stacks.
      composeProject: String(row.Labels ?? '').split(',').find((part) => part.startsWith('com.docker.compose.project='))?.split('=')[1] ?? null,
      composeService: String(row.Labels ?? '').split(',').find((part) => part.startsWith('com.docker.compose.service='))?.split('=')[1] ?? null,
      labelsRaw: String(row.Labels ?? ''),
    };
  });

  // Enrich with inspect data (ports/mounts/health) in one batched call.
  const ids = containers.map((container) => container.id).filter(Boolean);
  if (ids.length > 0) {
    const inspectOut = await tryRun('docker', ['inspect', ...ids], {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (inspectOut) {
      try {
        const details = JSON.parse(inspectOut);
        const byId = new Map(details.map((detail) => [detail.Id, detail]));
        for (const container of containers) {
          const detail = byId.get(container.id) ?? details.find((entry) => entry.Id?.startsWith(container.id));
          if (!detail) continue;
          const state = detail.State ?? {};
          const config = detail.Config ?? {};
          container.health = state.Health?.Status ?? null;
          container.startedAt = state.StartedAt ?? null;
          container.restartPolicy = detail.HostConfig?.RestartPolicy?.Name ?? 'no';
          container.portsDetailed = summarizePorts(detail.NetworkSettings?.Ports ?? {}, detail.HostConfig?.PortBindings ?? {});
          container.mounts = (detail.Mounts ?? []).map((mount) => ({
            type: mount.Type,
            source: mount.Source ?? mount.Name ?? '',
            destination: mount.Destination,
            mode: mount.Mode || (mount.RW ? 'rw' : 'ro'),
          }));
          container.env = (config.Env ?? []).map(maskEnv);
          container.command = [config.Entrypoint, config.Cmd]
            .map((value) => (Array.isArray(value) ? value.join(' ') : value ?? ''))
            .filter(Boolean)
            .join(' ');
          container.imageId = detail.Image ?? null;
        }
      } catch {
        /* inspect payload malformed — the ps-level data is still usable */
      }
    }
  }
  return containers;
}

/** Turn Docker's port maps into a flat, displayable list. */
function summarizePorts(exposed, bindings) {
  const result = [];
  for (const [key, map] of Object.entries(bindings ?? {})) {
    const [containerPort, protocol = 'tcp'] = key.split('/');
    if (!map || map.length === 0) {
      result.push({ containerPort: Number(containerPort), hostPort: null, hostIp: null, protocol });
      continue;
    }
    for (const binding of map) {
      result.push({
        containerPort: Number(containerPort),
        hostPort: binding.HostPort ? Number(binding.HostPort) : null,
        hostIp: binding.HostIp || null,
        protocol,
      });
    }
  }
  // Also surface exposed-but-unpublished ports (no host binding).
  for (const [key, value] of Object.entries(exposed ?? {})) {
    const [containerPort, protocol = 'tcp'] = key.split('/');
    if (value === null && !result.some((entry) => entry.containerPort === Number(containerPort))) {
      result.push({ containerPort: Number(containerPort), hostPort: null, hostIp: null, protocol });
    }
  }
  return result.sort((a, b) => a.containerPort - b.containerPort);
}

/** Hide the value of obvious secrets; the key stays visible so config is readable. */
function maskEnv(entry) {
  const eq = entry.indexOf('=');
  if (eq < 0) return { key: entry, value: '' };
  const key = entry.slice(0, eq);
  const value = entry.slice(eq + 1);
  const secret = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(key);
  return { key, value: secret ? '••••••••' : value };
}

/** Validate a container identifier before it reaches a command. */
function checkRef(ref) {
  if (!NAME_RE.test(ref) && !ID_RE.test(ref)) throw new ApiError('VALIDATION_BAD_NAME', '无效的容器标识');
  return ref;
}

/**
 * Lifecycle action on one container.
 * @param {'start'|'stop'|'restart'|'pause'|'unpause'|'kill'} action
 * @param {string} ref
 */
export async function controlContainer(action, ref) {
  const allowed = new Set(['start', 'stop', 'restart', 'pause', 'unpause', 'kill']);
  if (!allowed.has(action)) throw new ApiError('VALIDATION_BAD_ACTION', `不支持的操作: ${action}`);
  const target = checkRef(ref);
  const out = await tryRun('docker', [action, target], { timeout: 60000 });
  if (out === null) throw new ApiError('DOCKER_ACTION_FAILED', `docker ${action} ${target} 执行失败`);
  return { ok: true };
}

/** Remove a container, optionally with its anonymous volumes. */
export async function removeContainer(ref, force = false) {
  const target = checkRef(ref);
  const args = ['rm', target];
  if (force) args.push('-f');
  const out = await tryRun('docker', args, { timeout: 60000 });
  if (out === null) throw new ApiError('DOCKER_ACTION_FAILED', '删除容器失败（可能仍在运行，可尝试强制删除）');
  return { ok: true };
}

/** Tail of a container's stdout/stderr. */
export async function containerLogs(ref, lines = 300) {
  const target = checkRef(ref);
  const count = Math.min(5000, Math.max(1, Number(lines) || 300));
  const out = await tryRun('docker', ['logs', '--tail', String(count), '--timestamps', target], {
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (out === null) return { available: false, lines: [] };
  const rows = out
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => ({ index, raw: line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') }));
  return { available: true, lines: rows };
}

/** Effect of the last `docker stats` sample, per running container. */
export async function containerStats() {
  const rows = await dockerJson(['stats', '--no-stream', '--format', '{{json .}}'], 25000);
  const result = new Map();
  for (const row of rows) {
    result.set(String(row.Name ?? ''), {
      cpu: round(Number(String(row.CPUPerc ?? '0').replace('%', '')) || 0, 2),
      memory: parseBytes(String(row.MemUsage ?? '').split('/')[0]?.trim() ?? ''),
      memoryPercent: round(Number(String(row.MemPerc ?? '0').replace('%', '')) || 0, 2),
      net: String(row.NetIO ?? ''),
      block: String(row.BlockIO ?? ''),
      pids: Number(row.PIDs ?? 0) || 0,
    });
  }
  return result;
}

/** Parse "123.4MiB" style strings into bytes. */
function parseBytes(text) {
  const match = text.match(/([\d.]+)\s*([KMGTP]?i?B)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const factors = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 };
  return Math.round(value * (factors[unit] ?? 1));
}

/* ------------------------------------------------------------------ */
/* images / volumes / networks                                         */
/* ------------------------------------------------------------------ */

export async function listImages() {
  const rows = await dockerJson([
    'images',
    '--format', '{{json .}}',
  ]);
  return rows.map((row) => ({
    id: String(row.ID ?? ''),
    repository: String(row.Repository ?? ''),
    tag: String(row.Tag ?? ''),
    size: String(row.Size ?? ''),
    createdSince: String(row.CreatedSince ?? ''),
  }));
}

export async function listVolumes() {
  const out = await tryRun('docker', ['volume', 'ls', '--format', '{{json .}}'], { timeout: 12000 });
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line);
        return { name: String(row.Name ?? ''), driver: String(row.Driver ?? ''), mountpoint: String(row.Mountpoint ?? '') };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function listNetworks() {
  const out = await tryRun('docker', ['network', 'ls', '--format', '{{json .}}'], { timeout: 12000 });
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const row = JSON.parse(line);
        return {
          id: String(row.ID ?? ''),
          name: String(row.Name ?? ''),
          driver: String(row.Driver ?? ''),
          scope: String(row.Scope ?? ''),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Disk usage summary shown on the Docker page header. */
export async function diskUsage() {
  const out = await tryRun('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: 20000 });
  if (!out) return null;
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* header or warning line */
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* compose projects                                                    */
/* ------------------------------------------------------------------ */

/**
 * Group containers into compose stacks.
 *
 * There is no daemon-side notion of a "stack" — compose simply labels its
 * containers — so projects are derived from those labels.
 */
export async function listStacks() {
  const containers = await listContainers();
  /** @type {Map<string, any>} */
  const stacks = new Map();
  for (const container of containers) {
    const project = container.composeProject;
    if (!project) continue;
    const stack = stacks.get(project) ?? {
      name: project,
      running: 0,
      total: 0,
      services: [],
      workingDir: null,
      configFile: null,
    };
    stack.total += 1;
    if (container.state === 'running') stack.running += 1;
    stack.services.push({
      name: container.composeService ?? container.name,
      container: container.name,
      state: container.state,
      status: container.status,
    });
    stacks.set(project, stack);
  }

  // Find where each project's compose file lives, so the UI can offer "edit".
  for (const stack of stacks.values()) {
    const path = await tryRun('sh', [
      '-c',
      `docker inspect $(docker ps -aq --filter "label=com.docker.compose.project=${stack.name}" | head -1) --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null`,
    ], { timeout: 12000 });
    if (path && path.includes('|')) {
      const [workingDir, configFile] = path.trim().split('|');
      stack.workingDir = workingDir || null;
      stack.configFile = configFile || null;
    }
  }

  return [...stacks.values()];
}

/** Compose lifecycle for a whole stack. */
export async function controlStack(stackName, action) {
  if (!NAME_RE.test(stackName)) throw new ApiError('VALIDATION_BAD_NAME', '无效的项目名');
  const allowed = new Set(['start', 'stop', 'restart', 'down', 'up']);
  if (!allowed.has(action)) throw new ApiError('VALIDATION_BAD_ACTION', `不支持的操作: ${action}`);

  const findFile = await tryRun('sh', [
    '-c',
    `docker inspect $(docker ps -aq --filter "label=com.docker.compose.project=${stackName}" | head -1) --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null`,
  ], { timeout: 12000 });
  const configFile = (findFile ?? '').trim().split(',')[0];
  if (!configFile) throw new ApiError('NOTFOUND_PROJECT', '找不到该项目的 compose 文件');

  const args = action === 'down'
    ? ['compose', '-f', configFile, '-p', stackName, 'down']
    : action === 'up'
      ? ['compose', '-f', configFile, '-p', stackName, 'up', '-d']
      : ['compose', '-f', configFile, '-p', stackName, action];

  const out = await tryRun('docker', args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (out === null) throw new ApiError('DOCKER_COMPOSE_FAILED', `compose ${action} 执行失败`);
  return { ok: true, output: out.slice(-2000) };
}
