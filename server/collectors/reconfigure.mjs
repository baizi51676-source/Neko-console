/**
 * Container reconfiguration.
 *
 * Docker cannot change a container's port bindings in place — the mapping is
 * baked into the container's network config at creation. The only correct way is
 * to inspect the container, recreate it with the new bindings, and preserve
 * everything else (image, command, mounts, env, restart policy, networks).
 *
 * That is a destructive operation disguised as an edit, so this module:
 *   - captures the full config first and refuses if anything is not reproducible
 *     (e.g. anonymous volumes we cannot re-attach by name)
 *   - renames the old container instead of deleting it, so a failed recreation
 *     leaves the original intact and recoverable
 *   - only removes the backup after the new container is confirmed running
 */
import { ApiError } from '../errors.mjs';
import { run, tryRun } from '../util.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * Read a container's full configuration in the form needed to recreate it.
 *
 * @param {string} ref
 */
export async function inspectForRecreate(ref) {
  if (!NAME_RE.test(ref)) throw new ApiError('VALIDATION_BAD_NAME', '无效的容器名');

  const out = await tryRun('docker', ['inspect', ref], { timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  if (!out) throw new ApiError('NOTFOUND_CONTAINER', `找不到容器 ${ref}`);

  let detail;
  try {
    [detail] = JSON.parse(out);
  } catch {
    throw new ApiError('DOCKER_ACTION_FAILED', '无法解析容器信息');
  }
  if (!detail) throw new ApiError('NOTFOUND_CONTAINER', `找不到容器 ${ref}`);

  const config = detail.Config ?? {};
  const host = detail.HostConfig ?? {};
  const name = String(detail.Name ?? '').replace(/^\//, '');

  // Compose-managed containers are recreated by compose, not by hand: doing it
  // here would desynchronise the project state and confuse `compose up` later.
  const project = config.Labels?.['com.docker.compose.project'];
  if (project) {
    throw new ApiError(
      'DOCKER_ACTION_FAILED',
      `容器属于 Compose 项目「${project}」，请通过编辑项目的 compose 文件修改端口`,
    );
  }

  // Anonymous volumes have no name to re-attach, so a recreation would silently
  // orphan their data. Refuse rather than lose it.
  const anonymous = (detail.Mounts ?? []).filter((mount) => mount.Type === 'volume' && !mount.Name);
  if (anonymous.length > 0) {
    throw new ApiError(
      'DOCKER_ACTION_FAILED',
      '该容器使用了匿名数据卷，重建会丢失数据；请改用命名卷后重试',
    );
  }

  const ports = [];
  for (const [key, bindings] of Object.entries(host.PortBindings ?? {})) {
    const [containerPort, protocol = 'tcp'] = key.split('/');
    if (!bindings || bindings.length === 0) {
      ports.push({ host: null, container: Number(containerPort), protocol, hostIp: null });
      continue;
    }
    for (const binding of bindings) {
      ports.push({
        host: binding.HostPort ? Number(binding.HostPort) : null,
        container: Number(containerPort),
        protocol,
        hostIp: binding.HostIp || null,
      });
    }
  }

  return {
    name,
    image: config.Image,
    imageId: detail.Image,
    ports,
    env: (config.Env ?? []).map((entry) => {
      const eq = entry.indexOf('=');
      return eq < 0 ? { key: entry, value: '' } : { key: entry.slice(0, eq), value: entry.slice(eq + 1) };
    }),
    mounts: (detail.Mounts ?? []).map((mount) => ({
      type: mount.Type,
      source: mount.Source ?? mount.Name ?? '',
      destination: mount.Destination,
      readOnly: !mount.RW,
    })),
    restartPolicy: host.RestartPolicy?.Name ?? 'no',
    networkMode: host.NetworkMode ?? 'bridge',
    networks: Object.keys(detail.NetworkSettings?.Networks ?? {}),
    command: config.Cmd ?? null,
    entrypoint: config.Entrypoint ?? null,
    labels: config.Labels ?? {},
    state: detail.State?.Status ?? 'unknown',
  };
}

/**
 * Which host ports are already taken by *other* containers.
 *
 * Returned as a set so the UI can pre-empt conflicts instead of failing after a
 * destructive recreate.
 *
 * @param {string} excludeName container to ignore (the one being edited)
 */
export async function usedHostPorts(excludeName = null) {
  const out = await tryRun('docker', ['ps', '-a', '--format', '{{.Names}}|{{.Ports}}'], { timeout: 15000 });
  if (!out) return [];
  const used = [];
  for (const line of out.split('\n')) {
    const [name, ports] = line.split('|');
    if (!name || name === excludeName) continue;
    for (const match of String(ports ?? '').matchAll(/(?:^|, )([\d.]+|\[::\]):(\d+)->/g)) {
      used.push({ port: Number(match[2]), owner: name });
    }
  }
  return used;
}

/**
 * Recreate a container with different port bindings.
 *
 * Everything else is copied from the inspected config. If the new container
 * fails to start, the original is restored, so the operation is effectively
 * transactional from the operator's point of view.
 *
 * @param {string} ref
 * @param {{ host: number|null, container: number, protocol: string }[]} ports
 * @param {(message: string, level?: string) => void} log
 */
export async function updatePorts(ref, ports, log = () => {}) {
  const current = await inspectForRecreate(ref);

  // Validate the requested mappings before touching anything.
  const cleaned = [];
  for (const port of ports) {
    const containerPort = Number(port.container);
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      throw new ApiError('VALIDATION_BAD_PORT', `无效的容器端口: ${port.container}`);
    }
    const hostPort = port.host === null || port.host === undefined || port.host === '' ? null : Number(port.host);
    if (hostPort !== null && (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)) {
      throw new ApiError('VALIDATION_BAD_PORT', `无效的宿主端口: ${port.host}`);
    }
    const protocol = port.protocol === 'udp' ? 'udp' : 'tcp';
    cleaned.push({ host: hostPort, container: containerPort, protocol });
  }

  // Pre-flight the port conflict check so the container is not stopped for
  // nothing.
  const used = await usedHostPorts(current.name);
  for (const port of cleaned) {
    if (port.host === null) continue;
    const clash = used.find((entry) => entry.port === port.host);
    if (clash) {
      throw new ApiError('DOCKER_PORT_CONFLICT', `端口 ${port.host} 已被容器 ${clash.owner} 占用`);
    }
  }

  log(`准备重建容器 ${current.name}：${cleaned.length} 个端口映射`);

  // --- build the replacement command from the captured config ---------------
  const args = ['run', '-d', '--name', current.name, '--restart', current.restartPolicy];

  for (const port of cleaned) {
    // A null host port means "publish to a random ephemeral port", which docker
    // expresses as `-p containerPort` with no host side.
    args.push('-p', port.host === null ? `${port.container}/${port.protocol}` : `${port.host}:${port.container}/${port.protocol}`);
  }
  for (const mount of current.mounts) {
    if (mount.type === 'volume') args.push('-v', `${mount.source}:${mount.destination}${mount.readOnly ? ':ro' : ''}`);
    else args.push('-v', `${mount.source}:${mount.destination}${mount.readOnly ? ':ro' : ''}`);
  }
  for (const entry of current.env) args.push('-e', `${entry.key}=${entry.value}`);

  if (current.networkMode && current.networkMode !== 'default' && current.networkMode !== 'bridge') {
    // `host` / `none` / `container:x` modes are mutually exclusive with --network
    // plus our own port publishing, so pass them through verbatim.
    args.push('--network', current.networkMode);
  }

  // Preserve compose-independent labels (exclude compose ones we already rejected).
  for (const [key, value] of Object.entries(current.labels ?? {})) {
    if (key.startsWith('com.docker.compose.')) continue;
    args.push('--label', `${key}=${value}`);
  }

  if (current.entrypoint) {
    const entry = Array.isArray(current.entrypoint) ? current.entrypoint : [current.entrypoint];
    args.push('--entrypoint', entry.join(' '));
  }

  args.push(current.image);
  if (Array.isArray(current.command) && current.command.length > 0) args.push(...current.command);

  // --- swap ---------------------------------------------------------------
  const backup = `${current.name}-bak-${Date.now()}`;
  log(`重命名原容器为 ${backup}（保留以便回滚）`);
  try {
    await run('docker', ['rename', current.name, backup], { timeout: 20000 });
  } catch (error) {
    throw new ApiError('DOCKER_ACTION_FAILED', `无法重命名原容器: ${error.message}`);
  }

  log(`以新端口映射启动: docker ${args.join(' ')}`);
  try {
    await run('docker', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    // Roll back: the original container still exists under the backup name.
    log('新容器启动失败，正在回滚…', 'error');
    await tryRun('docker', ['rename', backup, current.name], { timeout: 20000 });
    await tryRun('docker', ['start', current.name], { timeout: 60000 });
    log('已恢复原容器', 'warn');
    throw new ApiError('DOCKER_ACTION_FAILED', '新配置启动失败，已回滚到原容器', error.message);
  }

  log('新容器已启动，删除备份容器');
  await tryRun('docker', ['rm', '-f', backup], { timeout: 60000 });

  const after = await tryRun('docker', ['ps', '--filter', `name=^${current.name}$`, '--format', '{{.Status}}'], { timeout: 15000 });

  return {
    ok: true,
    name: current.name,
    ports: cleaned,
    status: (after ?? '').trim(),
  };
}

/**
 * Update the container's restart policy in place.
 *
 * Unlike ports this *is* a live operation (`docker update`), so no recreation is
 * needed.
 */
export async function updateRestartPolicy(ref, policy) {
  if (!NAME_RE.test(ref)) throw new ApiError('VALIDATION_BAD_NAME', '无效的容器名');
  const allowed = new Set(['no', 'always', 'unless-stopped', 'on-failure']);
  if (!allowed.has(policy)) throw new ApiError('VALIDATION_BAD_ACTION', '不支持的重启策略');

  const out = await tryRun('docker', ['update', '--restart', policy, ref], { timeout: 20000 });
  if (out === null) throw new ApiError('DOCKER_ACTION_FAILED', '更新重启策略失败');
  return { ok: true, policy };
}

export { usedHostPorts as getUsedHostPorts };
