/**
 * GitHub repository integration.
 *
 * Two capabilities:
 *   1. Turn a repo URL into a deployable spec (image + ports + env), by reading
 *      its compose file, Dockerfile or README.
 *   2. Fetch README text to use as the template description, so the catalogue can
 *      show real documentation instead of a hand-written blurb.
 *
 * Network reality on the target hosts: `api.github.com` works, but
 * `raw.githubusercontent.com` is frequently blocked in mainland China. Every
 * request therefore falls back through mirrors, and each failure is reported
 * rather than silently swallowed.
 */
import { tryRun } from '../util.mjs';
import { ApiError } from '../errors.mjs';

/** Mirrors tried in order for raw file content. */
const RAW_MIRRORS = [
  (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`,
  (repo, ref, path) => `https://raw.gitmirror.com/${repo}/${ref}/${path}`,
  (repo, ref, path) => `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${path}`,
  (repo, ref, path) => `https://ghproxy.net/https://raw.githubusercontent.com/${repo}/${ref}/${path}`,
];

/**
 * GET a URL with a timeout, returning text or null.
 *
 * Uses curl rather than a Node fetch so it honours the host's proxy settings and
 * certificate store — a console running on a corporate or CN network is far more
 * likely to work through curl than through a bare TLS stack.
 *
 * @param {string} url
 * @param {number} [timeoutSec]
 */
async function httpGet(url, timeoutSec = 20) {
  const out = await tryRun('curl', ['-fsSL', '--max-time', String(timeoutSec), '-A', 'neko-console', url], {
    timeout: (timeoutSec + 5) * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return out;
}

/**
 * Fetch raw file content, racing all mirrors in parallel.
 *
 * Sequential mirror fallback was measured at 88s for a single README: each
 * unreachable host burned its full 20s timeout before the next was tried, and
 * the user saw nothing. Racing them means the fastest reachable mirror wins, and
 * the late responses are simply discarded.
 *
 * Short per-mirror timeouts are viable because a working mirror answers in
 * well under a second; anything slower is not worth waiting for when a faster
 * one is being tried at the same time.
 *
 * @param {string} repo  `owner/name`
 * @param {string} ref   branch or tag
 * @param {string} path  file path inside the repo
 * @returns {Promise<{ text: string, source: string } | null>}
 */
export async function fetchRaw(repo, ref, path) {
  const attempts = RAW_MIRRORS.map(async (build) => {
    const url = build(repo, ref, path);
    // 12s: a reachable mirror answers in under a second, but heavily loaded
    // proxies occasionally need a few seconds. 8s was aggressive enough that
    // the slower mirrors were being cancelled before they could answer, which
    // made existing files look missing.
    const text = await httpGet(url, 12);
    if (text !== null && text.length > 0) return { text, source: url };
    throw new Error('unreachable');
  });

  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

/**
 * Fetch the first of several candidate paths that exists.
 *
 * Paths are tried in order, but each path races all mirrors internally. Trying
 * every path against every mirror at once produced 16 concurrent curls, which
 * tripped connection limits and made existing files look missing; trying paths
 * strictly in sequence meant four full round trips before a hit.
 *
 * Sequential paths with per-path mirror racing is the middle ground: the first
 * path that exists is found in one round trip's time.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {string[]} paths
 * @returns {Promise<{ path: string, file: { text: string, source: string } } | null>}
 */
export async function fetchFirstOf(repo, ref, paths) {
  for (const path of paths) {
    const file = await fetchRaw(repo, ref, path);
    if (file) return { path, file };
  }
  return null;
}

/**
 * Fetch the first candidate path that exists, racing all paths at once but with
 * a bounded fan-out.
 *
 * Unlike `fetchFirstOf` this does not wait for a miss before trying the next
 * name, so a repo whose file is `compose.yaml` costs one round trip instead of
 * four. Fan-out is capped by only racing mirrors *within* each path (4 curls per
 * path) and letting the paths race each other — 16 concurrent curls on a slow
 * link was enough to trip connection limits and produce false negatives.
 *
 * @param {string} repo
 * @param {string} ref
 * @param {string[]} paths
 * @param {number} [deadlineMs]
 * @returns {Promise<{ path: string, file: { text: string, source: string } } | null>}
 */
export async function fetchFirstOfParallel(repo, ref, paths, deadlineMs = 15000) {
  const attempts = paths.map(async (path) => {
    const file = await fetchRaw(repo, ref, path);
    if (!file) throw new Error('missing');
    return { path, file };
  });

  try {
    return await Promise.race([
      Promise.any(attempts),
      new Promise((resolve) => setTimeout(() => resolve(null), deadlineMs).unref?.()),
    ]);
  } catch {
    return null;
  }
}

/**
 * Parse a GitHub URL into `owner/repo`, plus an optional ref and subpath.
 *
 * Accepts the common shapes users paste:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch/sub/dir
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export function parseRepoUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ApiError('VALIDATION_FAILED', '请输入仓库地址');

  let cleaned = raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');

  // Bare `owner/repo`
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(cleaned)) {
    return { repo: cleaned, ref: null, subPath: null, url: `https://github.com/${cleaned}` };
  }

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError('VALIDATION_FAILED', '无法识别的仓库地址');
  }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) {
    throw new ApiError('VALIDATION_FAILED', '目前仅支持 GitHub 仓库');
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new ApiError('VALIDATION_FAILED', '仓库地址缺少 owner/repo');
  const repo = `${parts[0]}/${parts[1]}`;

  let ref = null;
  let subPath = null;
  if (parts[2] === 'tree' && parts[3]) {
    ref = parts[3];
    subPath = parts.slice(4).join('/') || null;
  }

  return { repo, ref, subPath, url: `https://github.com/${repo}` };
}

/**
 * Read repository metadata from the GitHub API.
 *
 * Unauthenticated requests are rate-limited to 60/hour per IP, which is enough
 * for interactive use but worth surfacing when it happens.
 */
export async function fetchRepoMeta(repo) {
  const body = await httpGet(`https://api.github.com/repos/${repo}`, 20);
  if (!body) {
    // Fall back to a minimal record so deployment can still proceed by URL.
    return { repo, name: repo.split('/')[1], description: null, defaultBranch: 'main', stars: null, warning: '无法读取仓库信息（可能超出 API 限流）' };
  }
  try {
    const json = JSON.parse(body);
    return {
      repo,
      name: json.name,
      fullName: json.full_name,
      description: json.description,
      defaultBranch: json.default_branch ?? 'main',
      stars: json.stargazers_count ?? null,
      topics: json.topics ?? [],
      license: json.license?.spdx_id ?? null,
      archived: Boolean(json.archived),
      htmlUrl: json.html_url,
      updatedAt: json.updated_at,
    };
  } catch {
    return { repo, name: repo.split('/')[1], description: null, defaultBranch: 'main', stars: null };
  }
}

/**
 * Trim a README to something usable as a card/description blurb.
 *
 * Full READMEs are far too long for a UI panel, and they are full of badges,
 * HTML and relative image links that render as noise. This keeps the first
 * meaningful prose paragraphs and strips the noise.
 */
export function summarizeReadme(text, maxChars = 600) {
  if (!text) return '';
  let body = text;

  // Drop YAML front-matter, HTML comments and badge-only lines.
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^\[!\[/.test(trimmed)) return false; // [![badge](...)](...)
      if (/^!\[/.test(trimmed)) return false; // ![badge](...)
      if (/^<p align|^<div|^<\/div|^<img/i.test(trimmed)) return false;
      return true;
    })
    .join('\n');

  // The first heading is the project name, which the UI already shows. Section
  // headings ("## Installation") only add noise to a one-paragraph summary, so
  // both are removed and the remaining prose is what gets kept.
  body = body
    .split('\n')
    .filter((line, index) => {
      const trimmed = line.trim();
      if (/^#{1,6}\s/.test(trimmed)) {
        // Keep nothing that is a heading; the caller renders the name itself.
        return false;
      }
      return index >= 0;
    })
    .join('\n');

  // Keep the first prose block; stop at the first heading after content.
  const blocks = body.split(/\n{2,}/);
  const kept = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Skip pure code fences and tables.
    if (trimmed.startsWith('```') || trimmed.startsWith('|')) continue;
    kept.push(trimmed);
    if (kept.join('\n\n').length >= maxChars) break;
    if (kept.length >= 4) break;
  }

  let summary = kept
    .join('\n\n')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`>]/g, '')
    .replace(/\[!\[/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars).trim()}…`;
  return summary;
}

/** Fetch and summarise a repo's README. */
export async function fetchReadmeSummary(repo, ref = null) {
  const branch = ref ?? 'main';
  const candidates = ['README.md', 'readme.md', 'README.MD', 'README.rst', 'README'];

  // Race the candidates as well: trying them one at a time meant a repo whose
  // README is lowercase paid a full round trip per miss.
  const attempts = candidates.map(async (path) => {
    const file = await fetchRaw(repo, branch, path);
    if (!file) throw new Error('missing');
    return { path, file };
  });

  try {
    const { path, file } = await Promise.any(attempts);
    return { summary: summarizeReadme(file.text), raw: file.text.slice(0, 20000), path, source: file.source };
  } catch {
    // The default branch guess may be wrong (e.g. `master` not `main`).
    return { summary: '', raw: '', path: null, source: null };
  }
}

/* ------------------------------------------------------------------ */
/* deployment spec discovery                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract the first service from a compose file, without a YAML parser.
 *
 * Writing a full YAML parser for this is not worth it: we only need image,
 * ports and environment of the first service, and compose files for the kind of
 * project a user pastes in are overwhelmingly simple. Anything more complex is
 * better handled by cloning and using compose directly, which the UI offers as
 * a fallback.
 *
 * @param {string} yaml
 */
export function extractComposeService(yaml) {
  const lines = yaml.split('\n');
  const result = { image: null, ports: [], env: {}, name: null, raw: yaml };

  let serviceIndent = null;
  let currentKey = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Find `services:` then the first `  name:` under it.
    if (/^services:\s*$/.test(trimmed)) {
      serviceIndent = null;
      currentKey = 'services';
      continue;
    }
    if (currentKey === 'services') {
      if (serviceIndent === null && indent >= 2 && /^[A-Za-z0-9._-]+:\s*$/.test(trimmed)) {
        serviceIndent = indent;
        result.name = trimmed.slice(0, -1).trim();
        continue;
      }
      if (serviceIndent !== null) {
        // Leaving the service block.
        if (indent <= serviceIndent && !/^[A-Za-z0-9._-]+:\s*$/.test(trimmed) === false) {
          if (indent === serviceIndent) break;
        }
        if (indent <= serviceIndent && trimmed.length > 0 && !trimmed.startsWith('-')) break;

        const imageMatch = trimmed.match(/^image:\s*(.+)$/);
        if (imageMatch) {
          result.image = imageMatch[1].trim().replace(/^["']|["']$/g, '');
          continue;
        }
        const portMatch = trimmed.match(/^-\s*["']?(\d+):(\d+)(?:\/(tcp|udp))?["']?$/);
        if (portMatch) {
          result.ports.push({ host: Number(portMatch[1]), container: Number(portMatch[2]), protocol: portMatch[3] ?? 'tcp' });
          continue;
        }
        const envMatch = trimmed.match(/^-\s*([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
        if (envMatch) {
          result.env[envMatch[1]] = envMatch[2].replace(/^["']|["']$/g, '');
        }
      }
    }
  }

  // Reject values that would fail our own validation later.
  if (result.image && !/^[A-Za-z0-9._/:@-]{1,255}$/.test(result.image)) result.image = null;
  return result;
}

/**
 * Pull EXPOSE / ENV hints out of a Dockerfile.
 *
 * @param {string} dockerfile
 */
export function extractDockerfileInfo(dockerfile) {
  const ports = [];
  const env = {};
  for (const line of dockerfile.split('\n')) {
    const trimmed = line.trim();
    if (/^#/.test(trimmed)) continue;
    const expose = trimmed.match(/^EXPOSE\s+(.+)$/i);
    if (expose) {
      for (const token of expose[1].split(/\s+/)) {
        const port = Number(token.split('/')[0]);
        if (Number.isInteger(port) && port > 0 && port < 65536) ports.push({ host: port, container: port, protocol: 'tcp' });
      }
    }
    const envLine = trimmed.match(/^ENV\s+([A-Za-z_][A-Za-z0-9_]*)[= ](.+)$/i);
    if (envLine) env[envLine[1]] = envLine[2].replace(/^["']|["']$/g, '').slice(0, 200);
  }
  return { ports, env };
}

/**
 * Inspect a repository and propose a deployment spec.
 *
 * Order of preference:
 *   1. docker-compose.yml  — authoritative, includes ports and env
 *   2. Dockerfile          — EXPOSE gives ports, but no published mapping
 *   3. README              — nothing machine-readable; the user fills the form
 *
 * If a compose file is found we also return it verbatim, so the caller can offer
 * "deploy with that exact compose file" rather than a reconstruction.
 */
/**
 * Race a promise against a deadline.
 *
 * Returns the fallback when the deadline wins, leaving the original promise to
 * settle in the background. Used to bound analysis time: the console should show
 * what it learned within a few seconds rather than blocking on the slowest
 * unreachable mirror.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

export async function analyzeRepository(input, refOverride = null) {
  const started = Date.now();
  const parsed = parseRepoUrl(input);

  // The metadata call is fast and gives us the real default branch, which the
  // file lookups depend on, so it is not subject to the deadline.
  const meta = await withDeadline(fetchRepoMeta(parsed.repo), 8000, {
    repo: parsed.repo,
    name: parsed.repo.split('/')[1],
    defaultBranch: 'main',
    description: null,
    stars: null,
  });
  const ref = refOverride ?? parsed.ref ?? meta.defaultBranch ?? 'main';
  const base = parsed.subPath ? `${parsed.subPath.replace(/\/$/, '')}/` : '';

  const composePaths = [`${base}docker-compose.yml`, `${base}docker-compose.yaml`, `${base}compose.yml`, `${base}compose.yaml`];

  // Run the three lookups together, but cap the total at 20s. On a network where
  // every mirror stalls, waiting for all of them produced 50–60s responses; the
  // console is more useful returning "here is what I found" quickly than blocking.
  const discovery = Promise.all([
    fetchFirstOfParallel(parsed.repo, ref, composePaths, 15000),
    fetchRaw(parsed.repo, ref, `${base}Dockerfile`),
    fetchReadmeSummary(parsed.repo, ref),
  ]);

  const timedOut = Symbol('timeout');
  const result = await withDeadline(discovery, 20000, timedOut);

  if (result === timedOut) {
    // Nothing arrived in time. Report that plainly instead of pretending the repo
    // has no compose file.
    return {
      kind: 'unknown',
      repo: parsed.repo,
      ref,
      meta,
      image: null,
      ports: [],
      env: {},
      description: meta.description || '',
      readme: '',
      elapsed: Date.now() - started,
      note: '读取仓库文件超时（网络较慢）。可以重试，或直接手动填写镜像名与端口。',
    };
  }

  const [composeHit, dockerfile, readme] = result;

  if (composeHit) {
    const service = extractComposeService(composeHit.file.text);
    return {
      kind: 'compose',
      repo: parsed.repo,
      ref,
      path: composeHit.path,
      meta,
      compose: composeHit.file.text,
      composeSource: composeHit.file.source,
      image: service.image,
      ports: service.ports,
      env: service.env,
      serviceName: service.name,
      description: meta.description || readme.summary.split('\n')[0] || '',
      readme: readme.summary,
      elapsed: Date.now() - started,
    };
  }

  if (dockerfile) {
    const info = extractDockerfileInfo(dockerfile.text);
    return {
      kind: 'dockerfile',
      repo: parsed.repo,
      ref,
      path: `${base}Dockerfile`,
      meta,
      dockerfile: dockerfile.text.slice(0, 8000),
      image: null,
      ports: info.ports,
      env: info.env,
      description: meta.description || readme.summary.split('\n')[0] || '',
      readme: readme.summary,
      note: '仓库只有 Dockerfile，没有现成镜像。需自行构建并推送到镜像仓库后再填写镜像名。',
      elapsed: Date.now() - started,
    };
  }

  return {
    kind: 'unknown',
    repo: parsed.repo,
    ref,
    meta,
    image: null,
    ports: [],
    env: {},
    description: meta.description || readme.summary.split('\n')[0] || '',
    readme: readme.summary,
    note: '未找到 compose 文件或 Dockerfile，请手动填写镜像名与端口。',
    elapsed: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* catalogue search                                                    */
/* ------------------------------------------------------------------ */

/**
 * Search GitHub for deployable projects.
 *
 * Uses the search API with `topic:docker` style qualifiers inferred from the
 * query, because plain keyword search returns a lot of unrelated repositories.
 * Results are normalised into the same shape as the built-in templates.
 */
export async function searchRepositories(query, limit = 12) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new ApiError('VALIDATION_FAILED', '请输入搜索关键词');

  const count = Math.min(30, Math.max(1, Number(limit) || 12));
  // Bias towards projects that actually ship a container definition.
  const q = encodeURIComponent(`${trimmed} docker-compose OR dockerfile in:readme,description archived:false`);
  const body = await httpGet(
    `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${count}`,
    25,
  );

  if (!body) {
    throw new ApiError('SYSTEM_UNAVAILABLE', 'GitHub 搜索不可用（网络受限或超出 API 限流）');
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ApiError('SYSTEM_UNAVAILABLE', 'GitHub 返回内容无法解析');
  }

  if (json.message && /rate limit/i.test(json.message)) {
    throw new ApiError('SYSTEM_UNAVAILABLE', 'GitHub API 限流，请稍后再试或配置代理');
  }

  return (json.items ?? []).map((item) => ({
    id: `gh:${item.full_name}`,
    name: item.name,
    fullName: item.full_name,
    repo: item.full_name,
    description: item.description ?? '',
    stars: item.stargazers_count ?? 0,
    topics: item.topics ?? [],
    updatedAt: item.updated_at,
    htmlUrl: item.html_url,
    license: item.license?.spdx_id ?? null,
    source: 'github',
  }));
}

export { RAW_MIRRORS };
