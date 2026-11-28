/**
 * Docker, catalogue, GitHub and power routes.
 *
 * Kept separate from the core router so the console's own API stays readable,
 * and so everything that can mutate the host or its containers lives in one
 * auditable place.
 */
import {
  containerLogs,
  containerStats,
  controlContainer,
  controlStack,
  diskUsage,
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
  analyzeRepository,
  fetchReadmeSummary,
  fetchRepoMeta,
  parseRepoUrl,
  searchRepositories,
} from '../collectors/github.mjs';
import { getJob, cancelJob, listJobs, startJob, sweepJobs } from '../collectors/jobs.mjs';
import { getUsedHostPorts, inspectForRecreate, updatePorts, updateRestartPolicy } from '../collectors/reconfigure.mjs';
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

  // Finished jobs are swept periodically; cheap and keeps memory bounded.
  const sweeper = setInterval(sweepJobs, 5 * 60 * 1000);
  sweeper.unref?.();

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
    for (const container of containers) container.stats = stats.get(container.name) ?? null;
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
    await controlContainer(String(payload.action ?? ''), String(payload.name ?? ''));
    log(`docker: ${payload.action} container ${payload.name}`);
    sendOk(res, { action: payload.action, name: payload.name });
  });

  route('POST', '/api/docker/remove', async ({ res, body, sendOk }) => {
    const payload = await body();
    await removeContainer(String(payload.name ?? ''), Boolean(payload.force));
    log(`docker: removed container ${payload.name}`);
    sendOk(res, { name: payload.name });
  });

  /* ---------------- container reconfiguration ---------------- */

  route('GET', '/api/docker/container/config', async ({ res, url, sendOk }) => {
    const name = url.searchParams.get('name') ?? '';
    const config = await inspectForRecreate(name);
    const usedPorts = await getUsedHostPorts(name);
    sendOk(res, { config, usedPorts });
  });

  route('POST', '/api/docker/container/ports', async ({ res, body, sendOk }) => {
    const payload = await body();
    const name = String(payload.name ?? '');
    const ports = Array.isArray(payload.ports) ? payload.ports : [];
    // Ports require a container recreation, which is slow enough to warrant the
    // job machinery so the UI can show progress.
    const job = startJob(`${name}-ports`, async ({ log: jobLog }) => {
      const result = await updatePorts(name, ports, jobLog);
      log(`docker: rebuilt ${name} with ${ports.length} port mapping(s)`);
      return result;
    });
    sendOk(res, { jobId: job.id });
  });

  route('POST', '/api/docker/container/restart-policy', async ({ res, body, sendOk }) => {
    const payload = await body();
    sendOk(res, await updateRestartPolicy(String(payload.name ?? ''), String(payload.policy ?? '')));
  });

  /* ---------------- stacks ---------------- */

  route('POST', '/api/docker/stack', async ({ res, body, sendOk }) => {
    const payload = await body();
    const result = await controlStack(String(payload.name ?? ''), String(payload.action ?? ''));
    log(`docker: stack ${payload.name} ${payload.action}`);
    sendOk(res, result);
  });

  /* ---------------- catalogue ---------------- */

  route('GET', '/api/docker/catalog', async ({ res, sendOk }) => {
    sendOk(res, { templates: TEMPLATES, sources: REGISTRY_SOURCES });
  });

  /** Live search over GitHub for deployable projects. */
  route('GET', '/api/docker/search', async ({ res, url, sendOk }) => {
    const query = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 12);
    const results = await searchRepositories(query, limit);
    sendOk(res, { results, query });
  });

  /**
   * Analyse an arbitrary repository: find its compose file / Dockerfile / README
   * and propose a deployment spec from it.
   */
  route('POST', '/api/docker/analyze', async ({ res, body, sendOk }) => {
    const payload = await body();
    const url = String(payload.url ?? '');
    const ref = payload.ref ? String(payload.ref) : null;
    const analysis = await analyzeRepository(url, ref);
    sendOk(res, analysis);
  });

  /** README text for an arbitrary repo, used as the template description. */
  route('GET', '/api/docker/readme', async ({ res, url, sendOk }) => {
    const repo = url.searchParams.get('repo') ?? '';
    const parsed = parseRepoUrl(repo);
    // Resolve the real default branch first: guessing `main` fails on the many
    // repositories that still use `master`.
    const meta = await fetchRepoMeta(parsed.repo);
    const ref = parsed.ref ?? meta.defaultBranch ?? 'main';
    sendOk(res, { ...(await fetchReadmeSummary(parsed.repo, ref)), ref });
  });

  /* ---------------- deployment (async jobs) ---------------- */

  /**
   * Start a deployment and return immediately.
   *
   * Pulling a large image takes minutes; blocking the request meant the browser
   * sat on a spinner with no feedback, and long pulls could time out. The client
   * now polls /api/docker/job/<id> to render progress.
   */
  route('POST', '/api/docker/deploy', async ({ res, body, sendOk }) => {
    const payload = await body();
    const mode = payload.mode === 'compose' ? 'compose' : 'run';
    const templateId = payload.templateId ? String(payload.templateId) : null;
    if (templateId && !findTemplate(templateId)) throw new ApiError('NOTFOUND_TEMPLATE');

    const spec = normalizeSpec(payload.spec ?? payload, String(payload.source ?? 'github'), templateId);

    const job = startJob(spec.name, async ({ log: jobLog }) => {
      const result = mode === 'compose'
        ? await deployCompose(spec, String(payload.projectName ?? spec.name), jobLog)
        : await deployRun(spec, jobLog);
      log(`docker: deployed ${mode} ${spec.name} <- ${spec.image}`);
      return result;
    });

    sendOk(res, { jobId: job.id, name: spec.name, mode });
  });

  route('GET', '/api/docker/job', async ({ res, url, sendOk }) => {
    const id = url.searchParams.get('id') ?? '';
    const since = Number(url.searchParams.get('since') ?? 0);
    const job = getJob(id, Number.isFinite(since) ? since : 0);
    if (!job) throw new ApiError('NOTFOUND_ROUTE', '部署任务不存在或已过期');
    sendOk(res, job);
  });

  route('GET', '/api/docker/jobs', async ({ res, sendOk }) => {
    sendOk(res, { jobs: listJobs() });
  });

  route('POST', '/api/docker/job/cancel', async ({ res, body, sendOk }) => {
    const payload = await body();
    sendOk(res, { cancelled: cancelJob(String(payload.id ?? '')) });
  });

  /* ---------------- compose projects ---------------- */

  route('GET', '/api/docker/projects', async ({ res, sendOk }) => {
    sendOk(res, { projects: await listGeneratedProjects() });
  });

  route('GET', '/api/docker/project', async ({ res, url, sendOk }) => {
    sendOk(res, await readProject(url.searchParams.get('name') ?? ''));
  });

  route('POST', '/api/docker/project', async ({ res, body, sendOk }) => {
    const payload = await body();
    const result = await writeProject(String(payload.name ?? ''), String(payload.yaml ?? ''));
    log(`docker: project ${payload.name} updated`);
    sendOk(res, result);
  });

  /* ---------------- power ---------------- */

  route('GET', '/api/power', async ({ res, sendOk }) => {
    sendOk(res, { ...powerCapabilities(), pending: pendingActions() });
  });

  route('POST', '/api/power', async ({ res, body, sendOk }) => {
    const payload = await body();
    const result = await schedulePowerAction(
      String(payload.action ?? ''),
      String(payload.password ?? ''),
      ctx.config,
      log,
    );
    log(`power: ${payload.action} scheduled (token ${result.token.slice(0, 8)}…)`);
    sendOk(res, result);
  });

  route('POST', '/api/power/cancel', async ({ res, body, sendOk }) => {
    const payload = await body();
    sendOk(res, { cancelled: cancelPowerAction(String(payload.token ?? ''), log) });
  });
}
