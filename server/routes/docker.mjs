/**
 * Docker, catalogue and power routes.
 *
 * Kept in a separate module from the core router so the console's own API stays
 * readable, and so everything that can mutate the host or its containers lives
 * in one auditable place.
 */
import {
  containerLogs,
  containerStats,
  controlContainer,
  controlStack,
  diskUsage,
  containerStats as _stats,
  getDockerStatus,
  listContainers,
  listImages,
  listNetworks,
  listStacks,
  listVolumes,
  removeContainer,
} from '../collectors/docker.mjs';
import {
  REGISTRY_SOURCES,
  TEMPLATES,
  findTemplate,
  normalizeSpec,
} from '../collectors/catalog.mjs';
import {
  deployCompose,
  deployRun,
  listGeneratedProjects,
  readProject,
  writeProject,
} from '../collectors/deploy.mjs';
import {
  cancelPowerAction,
  pendingActions,
  powerCapabilities,
  schedulePowerAction,
} from '../collectors/power.mjs';
import { ApiError } from '../errors.mjs';

/**
 * @param {(method: string, path: string, handler: Function) => void} route
 * @param {{ log: (line: string) => void, config: object }} ctx
 */
export function registerDockerRoutes(route, ctx) {
  const { log } = ctx;

  /* ---------------- status & inventory ---------------- */

  route('GET', '/api/docker/status', async ({ res, sendOk }) => {
    const status = await getDockerStatus();
    if (!status.available) {
      sendOk(res, { ...status, containers: [], stacks: [], images: [], volumes: [], networks: [], usage: null });
      return;
    }
    const [containers, stacks, images, volumes, networks, usage, stats] = await Promise.all([
      listContainers(),
      listStacks(),
      listImages(),
      listVolumes(),
      listNetworks(),
      diskUsage(),
      containerStats(),
    ]);
    // Stats are keyed by container name and only exist for running containers.
    for (const container of containers) {
      container.stats = stats.get(container.name) ?? null;
    }
    sendOk(res, { ...status, containers, stacks, images, volumes, networks, usage });
  });

  route('GET', '/api/docker/containers', async ({ res, sendOk }) => {
    const containers = await listContainers();
    const stats = await containerStats();
    for (const container of containers) container.stats = stats.get(container.name) ?? null;
    sendOk(res, { containers });
  });

  route('GET', '/api/docker/logs', async ({ res, url, sendOk }) => {
    const name = url.searchParams.get('name') ?? '';
    const lines = Number(url.searchParams.get('lines') ?? 300);
    sendOk(res, await containerLogs(name, lines));
  });

  /* ---------------- container lifecycle ---------------- */

  route('POST', '/api/docker/action', async ({ res, body, sendOk }) => {
    const payload = await body();
    const action = String(payload.action ?? '');
    const name = String(payload.name ?? '');
    await controlContainer(action, name);
    log(`docker: ${action} container ${name}`);
    sendOk(res, { action, name });
  });

  route('POST', '/api/docker/remove', async ({ res, body, sendOk }) => {
    const payload = await body();
    const name = String(payload.name ?? '');
    await removeContainer(name, Boolean(payload.force));
    log(`docker: removed container ${name}`);
    sendOk(res, { name });
  });

  /* ---------------- stacks ---------------- */

  route('POST', '/api/docker/stack', async ({ res, body, sendOk }) => {
    const payload = await body();
    const name = String(payload.name ?? '');
    const action = String(payload.action ?? '');
    const result = await controlStack(name, action);
    log(`docker: stack ${name} ${action}`);
    sendOk(res, result);
  });

  /* ---------------- catalogue & deploy ---------------- */

  route('GET', '/api/docker/catalog', async ({ res, sendOk }) => {
    sendOk(res, {
      templates: TEMPLATES,
      sources: REGISTRY_SOURCES,
    });
  });

  route('POST', '/api/docker/deploy', async ({ res, body, sendOk }) => {
    const payload = await body();
    const mode = payload.mode === 'compose' ? 'compose' : 'run';
    const templateId = payload.templateId ? String(payload.templateId) : null;
    if (templateId && !findTemplate(templateId)) throw new ApiError('NOTFOUND_TEMPLATE', '未知的应用模板');

    const spec = normalizeSpec(payload.spec ?? payload, String(payload.source ?? 'github'), templateId);
    log(`docker: deploy ${mode} ${spec.name} <- ${spec.image}`);

    const result = mode === 'compose'
      ? await deployCompose(spec, String(payload.projectName ?? spec.name))
      : await deployRun(spec);

    sendOk(res, result);
  });

  route('GET', '/api/docker/projects', async ({ res, sendOk }) => {
    sendOk(res, { projects: await listGeneratedProjects() });
  });

  route('GET', '/api/docker/project', async ({ res, url, sendOk }) => {
    sendOk(res, await readProject(url.searchParams.get('name') ?? ''));
  });

  route('POST', '/api/docker/project', async ({ res, body, sendOk }) => {
    const payload = await body();
    const name = String(payload.name ?? '');
    const yaml = String(payload.yaml ?? '');
    const result = await writeProject(name, yaml);
    log(`docker: project ${name} updated`);
    sendOk(res, result);
  });

  /* ---------------- power ---------------- */

  route('GET', '/api/power', async ({ res, sendOk }) => {
    sendOk(res, { ...powerCapabilities(), pending: pendingActions() });
  });

  route('POST', '/api/power', async ({ res, body, sendOk }) => {
    const payload = await body();
    const action = String(payload.action ?? '');
    const password = String(payload.password ?? '');
    const result = await schedulePowerAction(action, password, ctx.config, log);
    log(`power: ${action} scheduled (token ${result.token.slice(0, 8)}…)`);
    sendOk(res, result);
  });

  route('POST', '/api/power/cancel', async ({ res, body, sendOk }) => {
    const payload = await body();
    const token = String(payload.token ?? '');
    const cancelled = cancelPowerAction(token, log);
    sendOk(res, { cancelled });
  });
}
