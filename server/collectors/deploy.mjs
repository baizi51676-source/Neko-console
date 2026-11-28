/**
 * Deployment engine.
 *
 * Turns a normalised spec into either a `docker run` or a compose project, then
 * pulls the image and starts it. Pull and start are reported separately so the
 * UI can show "pulling…" (slow, network-bound) before "starting" (fast).
 */
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryRun, run, isSafeToken } from '../util.mjs';
import { buildComposeFile, buildRunArgs } from './catalog.mjs';
import { ApiError, classifyDockerFailure } from '../errors.mjs';

/** Where generated compose projects live. */
export const STACK_ROOT = process.env.NEKO_STACK_ROOT ?? '/var/lib/neko-console/stacks';

/** Pull an image, returning the CLI output so failures are actionable. */
export async function pullImage(image) {
  if (!/^[A-Za-z0-9._/:@-]{1,255}$/.test(image)) throw new ApiError('VALIDATION_BAD_IMAGE', '无效的镜像名');
  const out = await tryRun('docker', ['pull', image], { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  if (out === null) throw new ApiError('DOCKER_IMAGE_UNAVAILABLE', `拉取镜像失败: ${image}`);
  return out.split('\n').filter(Boolean).slice(-6).join('\n');
}

/**
 * Ensure a host directory exists for a bind mount.
 *
 * Docker creates missing bind sources as root-owned directories, which then
 * breaks non-root containers. Creating them ahead of time and leaving the
 * ownership to the container image is friendlier.
 */
async function ensureDirs(spec) {
  for (const volume of spec.volumes) {
    if (!volume.host) continue;
    // Only real absolute paths; named volumes and sockets (files) are skipped.
    if (!volume.host.startsWith('/') || volume.host.includes('.sock')) continue;
    await mkdir(volume.host, { recursive: true }).catch(() => {});
  }
}

/**
 * Deploy with `docker run`.
 * @param {object} spec normalised spec from normalizeSpec()
 */
export async function deployRun(spec) {
  await ensureDirs(spec);

  // Refuse to shadow an existing container name rather than failing inside the
  // pull, which would waste the download.
  const existing = await tryRun('docker', ['ps', '-a', '--filter', `name=^${spec.name}$`, '--format', '{{.Names}}']);
  if ((existing ?? '').trim() === spec.name) {
    throw new ApiError('DOCKER_NAME_TAKEN', `容器名 ${spec.name} 已存在，请换一个名字或先删除旧容器`);
  }

  const pullOutput = await pullImage(spec.image);

  const args = buildRunArgs(spec);
  const created = await runCapture('docker', args);
  if (!created.ok) {
    // Classify like the compose path does: a busy port must not surface as a
    // generic "container failed to start".
    await tryRun('docker', ['rm', '-f', spec.name], { timeout: 30000 });
    throw created.apiError;
  }

  return {
    mode: 'run',
    name: spec.name,
    image: spec.image,
    command: `docker ${args.join(' ')}`,
    pullOutput,
    containerId: created.trim().slice(0, 12),
  };
}

/**
 * Deploy as a compose project.
 *
 * The compose file is written to a per-project directory so it can be edited and
 * re-applied later — that is the point of choosing compose over run.
 */
/**
 * Run a command and, on failure, classify it into a coded ApiError.
 *
 * Shared by `docker run` and `docker compose up` so both report the same codes
 * for the same underlying cause (port conflict, bad image, permission denied).
 *
 * @returns {Promise<{ ok: true, output: string } | { ok: false, apiError: Error }>}
 */
async function runCapture(file, args, timeout = 300000, fixedArgs = null) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      file,
      fixedArgs ?? args,
      {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const combined = `${stdout || ''}${stderr || ''}`.trim();
        if (error) {
          resolve({ ok: false, apiError: classifyDockerFailure(combined || error.message) });
          return;
        }
        resolve({ ok: true, output: combined });
      },
    );
  });
}

/**
 * Run `docker compose up -d` and decide success from the exit code, not from
 * the presence of stderr.
 *
 * compose writes progress ("Container x Started") to *stderr* while succeeding,
 * so treating any stderr as failure reports a started container as an error —
 * which is exactly what happened before this was fixed.
 *
 * @returns {Promise<{ ok: true, output: string } | { ok: false, apiError: Error }>}
 */
async function composeUp(file, projectName) {
  return runCapture('docker', null, 300000, ['compose', '-f', file, '-p', projectName, 'up', '-d']);
}

export async function deployCompose(spec, projectName = spec.name) {
  if (!isSafeToken(projectName, /^[a-z0-9][a-z0-9_.-]{0,62}$/)) throw new ApiError('VALIDATION_BAD_NAME', '无效的项目名');
  await ensureDirs(spec);

  const dir = join(STACK_ROOT, projectName);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'docker-compose.yml');
  const content = buildComposeFile(spec, projectName);

  if (existsSync(file)) {
    const existing = await readFile(file, 'utf8');
    if (!existing.includes(content.trim().split('\n')[0])) {
      // A different stack already owns this name; do not silently overwrite.
      throw new ApiError('DOCKER_NAME_TAKEN', `项目 ${projectName} 已存在且内容不同，请换一个项目名`);
    }
  }

  await writeFile(file, content, 'utf8');
  const pullOutput = await pullImage(spec.image);

  const up = await composeUp(file, projectName);
  if (!up.ok) {
    // Clean up so a failed deploy does not leave a half-created project behind.
    await tryRun('docker', ['compose', '-f', file, '-p', projectName, 'down'], { timeout: 60000 });
    throw up.apiError;
  }

  return {
    mode: 'compose',
    name: spec.name,
    projectName,
    image: spec.image,
    file,
    yaml: content,
    pullOutput,
    output: up.output.split('\n').filter(Boolean).slice(-8).join('\n'),
  };
}



/** List generated compose projects (ours, not ones created by hand). */
export async function listGeneratedProjects() {
  try {
    const entries = await readdir(STACK_ROOT, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(STACK_ROOT, entry.name, 'docker-compose.yml');
      if (!existsSync(file)) continue;
      projects.push({ name: entry.name, file });
    }
    return projects;
  } catch {
    return [];
  }
}

/** Read a generated compose file for the editor. */
export async function readProject(projectName) {
  if (!isSafeToken(projectName, /^[a-z0-9][a-z0-9_.-]{0,62}$/)) throw new ApiError('VALIDATION_BAD_NAME', '无效的项目名');
  const file = join(STACK_ROOT, projectName, 'docker-compose.yml');
  if (!existsSync(file)) throw new ApiError('NOTFOUND_PROJECT', '项目不存在');
  return { name: projectName, file, yaml: await readFile(file, 'utf8') };
}

/**
 * Apply an edited compose file.
 *
 * YAML is not parsed here: the file is written verbatim and `docker compose`
 * validates it, so syntax errors surface with Docker's own line-numbered
 * message rather than a half-implemented validator of ours.
 */
export async function writeProject(projectName, yaml) {
  if (!isSafeToken(projectName, /^[a-z0-9][a-z0-9_.-]{0,62}$/)) throw new ApiError('VALIDATION_BAD_NAME', '无效的项目名');
  if (typeof yaml !== 'string' || yaml.length > 512 * 1024) throw new ApiError('VALIDATION_TOO_LARGE', 'compose 内容过大');
  if (!/^\s*(services|version)\s*:/m.test(yaml)) throw new ApiError('DOCKER_COMPOSE_INVALID', '内容不像 compose 文件（缺少 services 段）');

  const dir = join(STACK_ROOT, projectName);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'docker-compose.yml');
  await writeFile(file, yaml, 'utf8');

  // Validate before applying so a broken edit does not take the stack down.
  const check = await run('docker', ['compose', '-f', file, '-p', projectName, 'config', '--quiet'], {
    timeout: 30000,
  }).then(() => true).catch((error) => {
    throw new ApiError('DOCKER_COMPOSE_INVALID', `compose 校验失败: ${error.message.split('\n')[0]}`);
  });
  if (!check) throw new ApiError('DOCKER_COMPOSE_INVALID', 'compose 校验失败');

  const up = await tryRun('docker', ['compose', '-f', file, '-p', projectName, 'up', '-d'], {
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (up === null) throw new ApiError('DOCKER_COMPOSE_FAILED', '应用失败');
  return { ok: true, file };
}
