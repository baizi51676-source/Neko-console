/**
 * nginx site management.
 *
 * The console owns a **managed directory** (`/etc/nginx/neko-sites/`) that it
 * creates and fully controls, and includes it from the stock nginx config. It
 * never edits files the operator may have written by hand under
 * `sites-enabled/` — those stay untouched, and a site the operator created
 * manually is simply invisible to us rather than at risk.
 *
 * Every change follows the same protocol:
 *   1. render the desired config from the database row
 *   2. write it atomically (temp file + rename)
 *   3. `nginx -t`
 *   4. on failure: restore the previous file and reload again, then report
 *   5. on success: reload
 *
 * Step 4 is what makes this safe to expose in a web UI: a malformed upstream is
 * a validation error the operator can fix, not an outage.
 */
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../errors.mjs';
import { run, tryRun } from '../util.mjs';
import { writeAtomic, writeIfChanged } from '../lib/atomic.mjs';

/** Where the console writes its own site files. */
export const MANAGED_DIR = process.env.NEKO_NGINX_DIR ?? '/etc/nginx/neko-sites';
/** The stock include file that pulls the managed dir in. */
const INCLUDE_FILE = '/etc/nginx/conf.d/neko-sites.conf';
/** Marker inside generated files, so we can recognise (and only delete) our own. */
const MARKER = '# managed by neko-console';

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

/**
 * Ensure the managed directory and its include line exist.
 *
 * Idempotent, and safe to run on every boot: it only creates what is missing.
 *
 * Throws a coded error when the parent nginx directory is absent — that means
 * nginx is not installed, which the UI should say plainly instead of surfacing
 * a raw ENOENT from the temp-file write.
 */
export async function ensureManagedDir() {
  const parent = '/etc/nginx/conf.d';
  if (!existsSync(parent)) {
    throw new ApiError(
      'DOCKER_UNAVAILABLE',
      '未检测到 nginx（/etc/nginx/conf.d 不存在）',
      '请先安装 nginx：apt install nginx',
    );
  }
  const includeExists = existsSync(parent);

  await mkdir(MANAGED_DIR, { recursive: true, mode: 0o755 });
  const include = `# managed by neko-console — do not edit by hand\ninclude ${MANAGED_DIR}/*.conf;\n`;
  const created = includeExists ? await writeIfChanged(INCLUDE_FILE, include, { mode: 0o644 }) : false;

  return { created, dir: MANAGED_DIR, include: INCLUDE_FILE };
}

/** True when the console's include is wired into nginx. */
export async function isWired() {
  return existsSync(INCLUDE_FILE);
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Turn a site into an nginx server block.
 *
 * Accepts both the database row shape (`server_names`, snake_case) and the
 * request shape (`serverNames`, camelCase). Mixing the two silently produced an
 * empty server_name and a confusing "at least one domain" error, so the
 * normalisation happens in one place rather than at every call site.
 *
 * @param {object} site
 * @param {{ includeSsl?: boolean }} [options]
 */
export function renderSite(site, options = {}) {
  const serverNames = site.server_names ?? site.serverNames ?? '';
  const names = String(serverNames)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length === 0) throw new ApiError('VALIDATION_FAILED', '至少需要一个域名');
  if (site.kind !== 'static' && site.kind !== 'proxy') {
    throw new ApiError('VALIDATION_FAILED', '站点类型必须是 static 或 proxy');
  }

  const lines = [];
  lines.push(MARKER);
  lines.push(`# site: ${site.name}`);

  // Accept both shapes here too: the route passes request-shaped objects while
  // the database returns rows. Reading only one left `server_name` empty.
  const sslEnabled = Boolean(site.ssl);
  const certName = site.cert_name ?? site.certName ?? null;
  const rootPath = site.root_path ?? site.rootPath ?? '';
  const indexed = site.indexed === undefined ? true : Boolean(site.indexed);

  const listen = sslEnabled && options.includeSsl !== false ? 'listen 443 ssl;' : 'listen 80;';

  lines.push(`server {`);
  lines.push(`    ${listen}`);
  if (sslEnabled && options.includeSsl !== false && certName) {
    lines.push(`    ssl_certificate     /etc/letsencrypt/live/${certName}/fullchain.pem;`);
    lines.push(`    ssl_certificate_key /etc/letsencrypt/live/${certName}/privkey.pem;`);
  }
  lines.push(`    server_name ${names.join(' ')};`);

  // ACME challenge is always served from the shared webroot so certificate
  // issuance works regardless of what the site itself serves.
  lines.push(`    location /.well-known/acme-challenge/ { root /var/www/neko-acme; }`);

  if (site.kind === 'proxy') {
    const upstream = String(site.upstream ?? '').trim();
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(upstream)) {
      // Only loopback upstreams: this is a same-host reverse proxy, and allowing
      // arbitrary hosts would turn the console into an open relay config tool.
      throw new ApiError('VALIDATION_FAILED', '上游必须是本机地址，如 127.0.0.1:3000');
    }
    lines.push(`    location / {`);
    lines.push(`        proxy_pass http://${upstream};`);
    lines.push(`        proxy_http_version 1.1;`);
    lines.push(`        proxy_set_header Host $host;`);
    lines.push(`        proxy_set_header X-Real-IP $remote_addr;`);
    lines.push(`        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
    lines.push(`        proxy_set_header X-Forwarded-Proto $scheme;`);
    lines.push(`        proxy_read_timeout 3600s;`);
    lines.push(`    }`);
  } else {
    const root = String(rootPath).trim();
    if (!root.startsWith('/')) throw new ApiError('VALIDATION_FAILED', '站点目录必须是绝对路径');
    lines.push(`    root ${root};`);
    lines.push(`    index index.html index.htm;`);
    if (indexed) lines.push(`    autoindex on;`);
    lines.push(`    location / { try_files $uri $uri/ =404; }`);
  }

  lines.push(`}`);
  lines.push('');

  // Plain-HTTP block that redirects to HTTPS once a certificate is in place.
  if (sslEnabled && certName && options.includeSsl !== false) {
    lines.push(`server {`);
    lines.push(`    listen 80;`);
    lines.push(`    server_name ${names.join(' ')};`);
    lines.push(`    location /.well-known/acme-challenge/ { root /var/www/neko-acme; }`);
    lines.push(`    location / { return 301 https://$host$request_uri; }`);
    lines.push(`}`);
    lines.push('');
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* nginx control                                                       */
/* ------------------------------------------------------------------ */

/**
 * Result file written by the privileged helper.
 *
 * `systemctl start` of a oneshot unit does not hand back stdout, so the helper
 * writes its output to a file the console can read. Reading a file also keeps
 * the console's sandbox intact — the alternative (removing NoNewPrivileges so
 * sudo works) would let a compromised console own the host.
 */
const HELPER_DIR = '/var/lib/neko-console/helper';
const HELPER_REQUEST = `${HELPER_DIR}/nginx-request`;
const HELPER_RESULT = `${HELPER_DIR}/nginx-result.json`;
/** Setuid-root helper that performs the privileged nginx operations. */
const HELPER_BIN = '/usr/local/lib/neko-console/bin/nginx-helper';

/**
 * Run one action through the privileged helper unit.
 *
 * The action is passed through a one-word request file rather than
 * `systemctl set-environment` (which needs its own polkit grant) or sudo (which
 * `NoNewPrivileges` correctly blocks). The root-owned helper whitelists the word,
 * so the console cannot make it do anything beyond validate/reload/status.
 *
 * @param {'test'|'reload'|'status'} action
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
async function runHelper(action) {
  await rm(HELPER_RESULT, { force: true }).catch(() => {});

  // systemd's path unit watches the request file and starts the root-owned helper.
  // Nothing privileged is invoked from here: the console only writes a word and
  // reads the answer, so its NoNewPrivileges sandbox is never weakened.
  //
  // The content includes a nonce so a repeated identical action still counts as a
  // modification — otherwise writing `test` twice in a row would not re-trigger.
  await writeAtomic(HELPER_REQUEST, `${action}\n${Date.now()}\n`, { mode: 0o644 });

  const deadline = Date.now() + 45000;
  let raw = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    raw = await readFile(HELPER_RESULT, 'utf8').catch(() => null);
    if (raw !== null) break;
  }
  if (raw === null) {
    // A tripped start limit leaves the path unit failed and no further triggers
    // arrive. Recover it once and report clearly if that fails too, because a
    // silently dead helper would make every later nginx action time out.
    const recovered = await tryRun('systemctl', ['reset-failed', 'neko-nginx-helper.path'], { timeout: 10000 });
    if (recovered !== null) {
      await tryRun('systemctl', ['start', 'neko-nginx-helper.path'], { timeout: 15000 });
      await writeAtomic(HELPER_REQUEST, `${action}\n${Date.now()}\n`, { mode: 0o644 });
      const retryDeadline = Date.now() + 20000;
      while (Date.now() < retryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        raw = await readFile(HELPER_RESULT, 'utf8').catch(() => null);
        if (raw !== null) break;
      }
    }
  }
  if (raw === null) {
    return {
      ok: false,
      output:
        '辅助单元未在超时内完成。请确认 deploy/neko-nginx-helper.path 与 .service 已安装并启用，'
        + '且 /var/lib/neko-console/helper 可写。',
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return { ok: Boolean(parsed.ok), output: String(parsed.output ?? '') };
  } catch {
    return { ok: false, output: '辅助单元结果无法解析' };
  }
}

/**
 * Run `nginx -t` and return its output.
 *
 * `nginx -t` needs root (error log, /run/nginx.pid). Direct execution is tried
 * first so a root-run console or a container without the helper still works;
 * otherwise it goes through the privileged helper.
 */
export async function testConfig() {
  const direct = await tryRun('nginx', ['-t'], { timeout: 20000 });
  if (direct !== null) return { ok: true, output: direct };

  return runHelper('test');
}

/** Reload nginx, surfacing a failure the caller can act on. */
export async function reload() {
  const direct = await tryRun('systemctl', ['reload', 'nginx'], { timeout: 30000 });
  if (direct !== null) return;

  const result = await runHelper('reload');
  if (!result.ok) {
    throw new ApiError('DOCKER_ACTION_FAILED', 'nginx 重载失败', result.output.slice(-500));
  }
}

/** Absolute path of a site's managed config file. */
export function siteFile(name) {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(name)) {
    throw new ApiError('VALIDATION_BAD_NAME', '站点名只能包含小写字母、数字、点和中划线');
  }
  return join(MANAGED_DIR, `${name}.conf`);
}

/**
 * Apply one site's config transactionally.
 *
 * Writes the new config, validates, and restores the previous content if nginx
 * rejects it. The reload only happens after a passing test, so a bad config
 * never reaches the running server.
 *
 * @param {object} site
 * @param {{ log?: (message: string, level?: string) => void }} [options]
 */
export async function applySite(site, options = {}) {
  const log = options.log ?? (() => {});
  await ensureManagedDir();

  const path = siteFile(site.name);
  const previous = await readFile(path, 'utf8').catch(() => null);
  const content = renderSite(site);

  log(`渲染 ${site.name} 配置`);
  await writeAtomic(path, content, { mode: 0o644 });

  log('校验 nginx 配置');
  const test = await testConfig();
  if (!test.ok) {
    log('校验失败，正在回滚', 'error');
    if (previous !== null) {
      await writeAtomic(path, previous, { mode: 0o644 });
    } else {
      await rm(path, { force: true });
    }
    // Reload after restoring so the running server matches the restored files.
    await reload().catch(() => {});
    throw new ApiError('DOCKER_COMPOSE_FAILED', 'nginx 配置校验失败，已回滚', test.output.slice(-800));
  }

  log('重载 nginx');
  await reload();
  return { path, content, reloaded: true };
}

/**
 * Remove a site's config file and reload.
 *
 * Only files carrying our marker are deleted, so a hand-written file that
 * happens to share the name is preserved.
 *
 * @param {string} name
 */
export async function removeSite(name) {
  const path = siteFile(name);
  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === null) return { removed: false };
  if (!existing.includes(MARKER)) {
    throw new ApiError('VALIDATION_FAILED', '该文件不是 Neko-console 管理的配置，已拒绝删除');
  }
  await rm(path, { force: true });
  const test = await testConfig();
  if (!test.ok) {
    // Put it back: removing this file broke the rest of the config somehow.
    await writeAtomic(path, existing, { mode: 0o644 });
    throw new ApiError('VALIDATION_FAILED', '删除后 nginx 校验失败，已恢复', test.output.slice(-500));
  }
  await reload();
  return { removed: true };
}

/** True when nginx is installed and running. */
export async function nginxStatus() {
  const version = await tryRun('nginx', ['-v'], { timeout: 8000 });
  const active = await tryRun('systemctl', ['is-active', 'nginx'], { timeout: 8000 });
  return {
    available: version !== null,
    version: (version ?? '').trim().replace(/^nginx version:\s*/, ''),
    running: (active ?? '').trim() === 'active',
    managedDir: MANAGED_DIR,
    wired: await isWired(),
  };
}

/** List files in the managed dir that we own. */
export async function listManagedFiles() {
  try {
    const entries = await readdir(MANAGED_DIR);
    const files = [];
    for (const entry of entries) {
      if (!entry.endsWith('.conf')) continue;
      const path = join(MANAGED_DIR, entry);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      const content = await readFile(path, 'utf8').catch(() => '');
      if (!content.includes(MARKER)) continue;
      files.push({ name: entry.replace(/\.conf$/, ''), path, size: info.size, modified: info.mtime.toISOString() });
    }
    return files;
  } catch {
    return [];
  }
}

export { MARKER, INCLUDE_FILE };
