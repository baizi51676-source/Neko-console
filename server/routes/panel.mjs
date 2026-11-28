/**
 * Panel routes: sites, certificates, databases, jobs, backups, audit.
 *
 * All privileged operations are audited before responding, and every mutating
 * call re-validates its input — the UI's validation is a convenience, not a
 * security boundary.
 */
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.mjs';
import {
  audit,
  deleteJob,
  deleteSite,
  findSiteByName,
  getJob,
  getSite,
  insertJob,
  insertSite,
  listAudit,
  listJobRuns,
  listJobs,
  listSites,
  updateJob,
  updateSite,
} from '../db/index.mjs';
import {
  applySite,
  ensureManagedDir,
  listManagedFiles,
  nginxStatus,
  removeSite,
  renderSite,
  testConfig,
} from '../lib/nginx.mjs';
import {
  certificateHealth,
  issueCertificate,
  installRenewalTimer,
  listCertificates,
  renewCertificate,
} from '../lib/certbot.mjs';
import {
  createMysql,
  createPostgres,
  detectEngines,
  dropMysql,
  dropPostgres,
  listDatabases,
} from '../lib/database.mjs';
import {
  ACTIONS,
  executeJob,
  listScripts,
  resolveCommand,
  runJobNow,
  validateSchedule,
} from '../lib/jobs.mjs';
import {
  backupMysql,
  backupPostgres,
  backupSite,
  backupSummary,
  pruneBackups,
  runFullBackup,
  verifyBackup,
} from '../lib/backup.mjs';

/**
 * Validate a site payload.
 *
 * @param {object} payload
 * @param {boolean} [partial] allow missing fields when updating
 */
function readSitePayload(payload, partial = false) {
  const require = (key) => {
    if (partial && payload[key] === undefined) return undefined;
    return payload[key];
  };

  const kind = require('kind');
  if (kind !== undefined && kind !== 'static' && kind !== 'proxy') {
    throw new ApiError('VALIDATION_FAILED', '站点类型必须是 static 或 proxy');
  }

  const serverNames = require('serverNames');
  if (serverNames !== undefined) {
    const list = String(serverNames).split(',').map((entry) => entry.trim()).filter(Boolean);
    if (list.length === 0) throw new ApiError('VALIDATION_FAILED', '至少需要一个域名');
    for (const name of list) {
      if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(name)) {
        throw new ApiError('VALIDATION_FAILED', `无效的域名: ${name}`);
      }
    }
  }

  // PHP is explicitly out of scope; reject rather than silently ignore, so the
  // operator is not left believing a PHP site was configured.
  if (payload.php === true) {
    throw new ApiError('VALIDATION_FAILED', '本控制台不提供 PHP 多版本共存功能');
  }

  return {
    kind,
    serverNames: serverNames === undefined ? undefined : String(serverNames),
    upstream: require('upstream'),
    rootPath: require('rootPath'),
    indexed: payload.indexed,
    ssl: payload.ssl,
    certName: require('certName'),
  };
}

/**
 * @param {(method: string, path: string, handler: Function) => void} route
 * @param {{ log: (line: string) => void }} ctx
 */
export function registerPanelRoutes(route, ctx) {
  const { log } = ctx;

  /* ---------------- overview ---------------- */

  route('GET', '/api/panel/status', async ({ res, sendOk }) => {
    const [nginx, certs, engines] = await Promise.all([
      nginxStatus(),
      certificateHealth().catch(() => ({ total: 0, expiringCount: 0, certificates: [], timer: null })),
      detectEngines().catch(() => []),
    ]);
    sendOk(res, {
      nginx,
      certificates: certs,
      databases: engines,
      sites: listSites().length,
      actions: Object.entries(ACTIONS).map(([name, action]) => ({ name, description: action.description })),
    });
  });

  /* ---------------- M1: sites ---------------- */

  route('GET', '/api/sites', async ({ res, sendOk }) => {
    const [sites, files] = await Promise.all([listSites(), listManagedFiles()]);
    const managed = new Set(files.map((file) => file.name));
    sendOk(res, {
      sites: sites.map((site) => ({ ...site, rendered: managed.has(site.name) })),
      managedFiles: files,
    });
  });

  route('GET', '/api/sites/preview', async ({ res, url, sendOk }) => {
    const id = url.searchParams.get('id');
    const site = id ? getSite(id) : null;
    if (!site) throw new ApiError('NOTFOUND_ROUTE', '站点不存在');
    sendOk(res, { config: renderSite(site) });
  });

  route('GET', '/api/sites/test', async ({ res, sendOk }) => {
    sendOk(res, await testConfig());
  });

  route('POST', '/api/sites/bootstrap', async ({ res, sendOk }) => {
    const result = await ensureManagedDir();
    audit('site.bootstrap', result.include, 'ok');
    log(`sites: 初始化托管目录 ${result.dir}`);
    sendOk(res, result);
  });

  route('POST', '/api/sites', async ({ res, body, sendOk }) => {
    const payload = await body();
    const name = String(payload.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(name)) {
      throw new ApiError('VALIDATION_BAD_NAME', '站点名只能包含小写字母、数字、点和中划线');
    }
    if (findSiteByName(name)) throw new ApiError('DOCKER_NAME_TAKEN', '同名站点已存在');

    const fields = readSitePayload(payload);
    const site = {
      id: randomUUID(),
      name,
      kind: fields.kind ?? 'static',
      serverNames: fields.serverNames ?? '',
      upstream: fields.upstream ?? null,
      rootPath: fields.rootPath ?? null,
      indexed: fields.indexed !== false,
      ssl: Boolean(fields.ssl),
      certName: fields.certName ?? null,
      php: false,
    };

    insertSite(site);
    try {
      await applySite(site, { log });
    } catch (error) {
      // Roll the database back so it never claims a site that nginx rejected.
      deleteSite(site.id);
      audit('site.create', name, 'error', error.message);
      throw error;
    }
    audit('site.create', name, 'ok', `${site.kind} ${site.serverNames}`);
    log(`sites: 创建 ${name}`);
    sendOk(res, { site: getSite(site.id) });
  });

  route('POST', '/api/sites/update', async ({ res, body, sendOk }) => {
    const payload = await body();
    const id = String(payload.id ?? '');
    const current = getSite(id);
    if (!current) throw new ApiError('NOTFOUND_ROUTE', '站点不存在');

    const fields = readSitePayload(payload, true);
    const next = {
      ...current,
      kind: fields.kind ?? current.kind,
      server_names: fields.serverNames ?? current.server_names,
      upstream: fields.upstream === undefined ? current.upstream : fields.upstream,
      root_path: fields.rootPath === undefined ? current.root_path : fields.rootPath,
      indexed: fields.indexed === undefined ? Boolean(current.indexed) : Boolean(fields.indexed),
      ssl: fields.ssl === undefined ? Boolean(current.ssl) : Boolean(fields.ssl),
      cert_name: fields.certName === undefined ? current.cert_name : fields.certName,
    };

    try {
      await applySite(next, { log });
    } catch (error) {
      audit('site.update', current.name, 'error', error.message);
      throw error;
    }
    updateSite(id, {
      kind: next.kind,
      server_names: next.server_names,
      upstream: next.upstream,
      root_path: next.root_path,
      indexed: next.indexed,
      ssl: next.ssl,
      cert_name: next.cert_name,
    });
    audit('site.update', current.name, 'ok');
    sendOk(res, { site: getSite(id) });
  });

  route('POST', '/api/sites/delete', async ({ res, body, sendOk }) => {
    const payload = await body();
    const id = String(payload.id ?? '');
    const site = getSite(id);
    if (!site) throw new ApiError('NOTFOUND_ROUTE', '站点不存在');

    await removeSite(site.name);
    deleteSite(id);
    audit('site.delete', site.name, 'ok');
    log(`sites: 删除 ${site.name}`);
    sendOk(res, { deleted: true });
  });

  /* ---------------- M3: certificates ---------------- */

  route('GET', '/api/certificates', async ({ res, sendOk }) => {
    sendOk(res, await certificateHealth());
  });

  route('GET', '/api/certificates/list', async ({ res, sendOk }) => {
    sendOk(res, { certificates: await listCertificates() });
  });

  route('POST', '/api/certificates/issue', async ({ res, body, sendOk }) => {
    const payload = await body();
    const domains = Array.isArray(payload.domains)
      ? payload.domains.map((domain) => String(domain))
      : String(payload.domain ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);

    try {
      const result = await issueCertificate(domains, log);
      audit('cert.issue', domains.join(','), 'ok');
      log(`certs: 已签发 ${domains.join(',')}`);
      sendOk(res, result);
    } catch (error) {
      audit('cert.issue', domains.join(','), 'error', error.message);
      throw error;
    }
  });

  route('POST', '/api/certificates/renew', async ({ res, body, sendOk }) => {
    const payload = await body();
    const result = await renewCertificate(String(payload.lineage ?? ''));
    audit('cert.renew', String(payload.lineage ?? ''), 'ok');
    sendOk(res, result);
  });

  route('POST', '/api/certificates/timer', async ({ res, sendOk }) => {
    const result = await installRenewalTimer();
    audit('cert.timer', result.timer, 'ok');
    sendOk(res, result);
  });

  /* ---------------- M2: databases ---------------- */

  route('GET', '/api/databases/engines', async ({ res, sendOk }) => {
    sendOk(res, { engines: await detectEngines() });
  });

  route('GET', '/api/databases/list', async ({ res, url, sendOk }) => {
    const engine = url.searchParams.get('engine') ?? 'mysql';
    sendOk(res, { engine, databases: await listDatabases(engine) });
  });

  route('POST', '/api/databases/create', async ({ res, body, sendOk }) => {
    const payload = await body();
    const engine = String(payload.engine ?? 'mysql');
    const params = {
      database: String(payload.database ?? ''),
      username: String(payload.username ?? ''),
      password: payload.password ? String(payload.password) : undefined,
      charset: payload.charset ? String(payload.charset) : undefined,
    };

    try {
      const result = engine === 'postgres' ? await createPostgres(params) : await createMysql(params);
      audit('db.create', `${engine}:${params.database}`, 'ok', `user=${params.username}`);
      log(`db: 创建 ${engine} 库 ${params.database}`);
      // The generated password is returned here and never stored anywhere else.
      sendOk(res, result);
    } catch (error) {
      audit('db.create', `${engine}:${params.database}`, 'error', error.message);
      throw error;
    }
  });

  route('POST', '/api/databases/drop', async ({ res, body, sendOk }) => {
    const payload = await body();
    const engine = String(payload.engine ?? 'mysql');
    const params = {
      database: String(payload.database ?? ''),
      username: payload.username ? String(payload.username) : null,
      force: payload.force === true,
    };

    try {
      const result = engine === 'postgres' ? await dropPostgres(params) : await dropMysql(params);
      audit('db.drop', `${engine}:${params.database}`, 'ok');
      log(`db: 删除 ${engine} 库 ${params.database}`);
      sendOk(res, result);
    } catch (error) {
      audit('db.drop', `${engine}:${params.database}`, 'error', error.message);
      throw error;
    }
  });

  /* ---------------- M4: jobs ---------------- */

  route('GET', '/api/jobs', async ({ res, sendOk }) => {
    sendOk(res, {
      jobs: listJobs().map((job) => ({ ...job, runs: listJobRuns(job.id, 3) })),
      actions: Object.entries(ACTIONS).map(([name, action]) => ({ name, description: action.description })),
      scripts: await listScripts(),
    });
  });

  route('POST', '/api/jobs', async ({ res, body, sendOk }) => {
    const payload = await body();
    const name = String(payload.name ?? '').trim();
    if (!name) throw new ApiError('VALIDATION_FAILED', '任务名不能为空');

    const schedule = String(payload.schedule ?? '');
    validateSchedule(schedule);

    const kind = ['auto', 'actions', 'script'].includes(String(payload.kind)) ? String(payload.kind) : 'auto';
    const command = String(payload.command ?? '');
    // Validate now so a job cannot be saved that will always fail at runtime.
    resolveCommand(command, kind);

    const id = insertJob({ name, schedule, command, kind, enabled: payload.enabled !== false });
    audit('job.create', name, 'ok', `${schedule} → ${command}`);
    sendOk(res, { job: getJob(id) });
  });

  route('POST', '/api/jobs/update', async ({ res, body, sendOk }) => {
    const payload = await body();
    const id = Number(payload.id);
    const current = getJob(id);
    if (!current) throw new ApiError('NOTFOUND_ROUTE', '任务不存在');

    const patch = {};
    if (payload.name !== undefined) patch.name = String(payload.name);
    if (payload.schedule !== undefined) {
      validateSchedule(String(payload.schedule));
      patch.schedule = String(payload.schedule);
    }
    if (payload.command !== undefined) {
      const kind = payload.kind !== undefined ? String(payload.kind) : current.kind;
      resolveCommand(String(payload.command), kind);
      patch.command = String(payload.command);
    }
    if (payload.kind !== undefined) patch.kind = String(payload.kind);
    if (payload.enabled !== undefined) patch.enabled = payload.enabled !== false;

    const job = updateJob(id, patch);
    audit('job.update', job.name, 'ok');
    sendOk(res, { job });
  });

  route('POST', '/api/jobs/delete', async ({ res, body, sendOk }) => {
    const payload = await body();
    const id = Number(payload.id);
    const job = getJob(id);
    if (!job) throw new ApiError('NOTFOUND_ROUTE', '任务不存在');
    deleteJob(id);
    audit('job.delete', job.name, 'ok');
    sendOk(res, { deleted: true });
  });

  route('POST', '/api/jobs/run', async ({ res, body, sendOk }) => {
    const payload = await body();
    const result = await runJobNow(Number(payload.id));
    sendOk(res, result);
  });

  route('GET', '/api/jobs/runs', async ({ res, url, sendOk }) => {
    const jobId = url.searchParams.get('jobId');
    sendOk(res, { runs: listJobRuns(jobId ? Number(jobId) : null, 20) });
  });

  /* ---------------- M5: backups ---------------- */

  route('GET', '/api/backups', async ({ res, sendOk }) => {
    sendOk(res, await backupSummary());
  });

  route('POST', '/api/backups/run', async ({ res, body, sendOk }) => {
    const payload = await body();
    const kind = String(payload.kind ?? 'full');

    try {
      if (kind === 'full') {
        const result = await runFullBackup();
        audit('backup.full', null, 'ok', `${result.files.length} files`);
        sendOk(res, result);
        return;
      }
      if (kind === 'database') {
        const engine = String(payload.engine ?? 'mysql');
        const database = String(payload.database ?? '');
        const result = engine === 'postgres'
          ? await backupPostgres(database)
          : await backupMysql(database);
        audit('backup.database', `${engine}:${database}`, 'ok');
        sendOk(res, result);
        return;
      }
      if (kind === 'site') {
        const result = await backupSite({
          label: String(payload.label ?? 'site'),
          path: String(payload.path ?? ''),
          excludes: Array.isArray(payload.excludes) ? payload.excludes.map(String) : [],
        });
        audit('backup.site', result.label, 'ok');
        sendOk(res, result);
        return;
      }
      throw new ApiError('VALIDATION_BAD_ACTION', '未知的备份类型');
    } catch (error) {
      audit('backup.run', kind, 'error', error.message);
      throw error;
    }
  });

  route('POST', '/api/backups/verify', async ({ res, body, sendOk }) => {
    const payload = await body();
    sendOk(res, await verifyBackup(String(payload.path ?? '')));
  });

  route('POST', '/api/backups/prune', async ({ res, sendOk }) => {
    const removed = await pruneBackups();
    audit('backup.prune', null, 'ok', `${removed.length} removed`);
    sendOk(res, { removed });
  });

  /* ---------------- audit ---------------- */

  route('GET', '/api/audit', async ({ res, url, sendOk }) => {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    sendOk(res, { entries: listAudit(limit) });
  });
}
