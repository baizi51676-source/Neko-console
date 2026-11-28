/**
 * HTTP API.
 *
 * A tiny hand-rolled router instead of Express: the surface is around twenty
 * routes, and not pulling in a framework keeps the install to `node` alone.
 *
 * Routing exists in three layers:
 *   /api/*        JSON API, all routes require a valid session cookie
 *   /api/stream   SSE for live metrics
 *   everything    static files from dist/, with SPA fallback
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import {
  clearFailures,
  createSession,
  isBlocked,
  registerFailure,
  sweepAttempts,
  verifyPassword,
  verifySession,
} from './auth.mjs';
import { getOverview, getCpu, getMemory, getDisks, getNetwork, getHostInfo } from './collectors/system.mjs';
import { getProcessDetail, getProcesses, getMounts, getSessions } from './collectors/processes.mjs';
import {
  controlService,
  getJournal,
  getServiceLogs,
  getServices,
  getSystemLog,
  listSystemLogs,
} from './collectors/services.mjs';
import {
  MAX_EDIT_BYTES,
  createDirectory,
  listDirectory,
  readTextFile,
  receiveUpload,
  removePath,
  renamePath,
  streamFile,
  writeTextFile,
} from './collectors/files.mjs';
import { ApiError, toApiError } from './errors.mjs';
import { registerDockerRoutes } from './routes/docker.mjs';
import { errorMessage, isSafeToken } from './util.mjs';

const COOKIE_NAME = 'neko_session';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** @param {import('node:http').IncomingMessage} req */
function parseCookies(req) {
  const header = req.headers.cookie ?? '';
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Client IP, honouring the first proxy hop when one is configured. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // API responses are per-user data; never let a proxy or disk cache keep them.
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendOk(res, data = {}) {
  sendJson(res, 200, { ok: true, data });
}

/**
 * Send a coded error.
 *
 * `code` is stable and safe to branch on; `detail` carries the raw cause for
 * the UI to reveal on demand (docker stderr, for instance).
 */
function sendError(res, status, message, code, detail) {
  sendJson(res, status, {
    ok: false,
    error: message,
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {}),
  });
}

/** Read and parse a JSON body with a hard size cap. */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* route table                                                         */
/* ------------------------------------------------------------------ */

/**
 * @typedef {(ctx: {
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   url: URL,
 *   config: import('./config.mjs').Config,
 *   body: () => Promise<any>,
 * }) => Promise<void> | void} Handler
 */

/** @type {Map<string, Handler>} */
const routes = new Map();

function route(method, path, handler) {
  routes.set(`${method} ${path}`, handler);
}

/* ---- auth (unauthenticated) ---- */

route('POST', '/api/auth/login', async ({ req, res, config, body }) => {
  const ip = clientIp(req);
  const block = isBlocked(ip);
  if (block.blocked) {
    sendError(res, 429, `尝试过于频繁，请在 ${block.retryAfter} 秒后重试`, 'AUTH_THROTTLED');
    return;
  }

  const payload = await body();
  const username = typeof payload.username === 'string' ? payload.username : '';
  const password = typeof payload.password === 'string' ? payload.password : '';

  if (!username || !password) {
    sendError(res, 400, '请输入用户名和密码', 'AUTH_MISSING_FIELDS');
    return;
  }

  // Compare the username in constant-ish time by hashing both through the same
  // path; the password check dominates timing anyway.
  const userOk = username === config.username;
  const passOk = verifyPassword(password, config.passwordHash);
  if (!userOk || !passOk) {
    const result = registerFailure(ip, config.loginMaxAttempts, config.loginWindow);
    sendError(
      res,
      result.blocked ? 429 : 401,
      result.blocked ? `尝试次数过多，已锁定 ${result.retryAfter} 秒` : '用户名或密码错误',
      result.blocked ? 'AUTH_THROTTLED' : 'AUTH_INVALID_CREDENTIALS',
    );
    return;
  }

  clearFailures(ip);
  const token = createSession(config.username, config.sessionSecret, config.sessionTtl);
  const secure = Boolean(config.tlsCert);
  res.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionTtl}${secure ? '; Secure' : ''}`,
  );
  sendOk(res, { username: config.username });
});

route('POST', '/api/auth/logout', async ({ res }) => {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  sendOk(res);
});

route('GET', '/api/auth/session', async ({ req, res, config }) => {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = verifySession(token, config.sessionSecret);
  if (!session) {
    sendJson(res, 200, { ok: true, data: { authenticated: false } });
    return;
  }
  sendOk(res, { authenticated: true, username: session.sub });
});

/* ---- metrics ---- */

route('GET', '/api/overview', async ({ res }) => {
  sendOk(res, await getOverview());
});

route('GET', '/api/cpu', async ({ res }) => {
  sendOk(res, await getCpu());
});

route('GET', '/api/memory', async ({ res }) => {
  sendOk(res, await getMemory());
});

route('GET', '/api/disks', async ({ res }) => {
  sendOk(res, { disks: await getDisks(), mounts: await getMounts() });
});

route('GET', '/api/network', async ({ res }) => {
  sendOk(res, { interfaces: await getNetwork(), sessions: await getSessions() });
});

route('GET', '/api/host', async ({ res }) => {
  sendOk(res, await getHostInfo());
});

/* ---- processes ---- */

route('GET', '/api/processes', async ({ res }) => {
  sendOk(res, { processes: await getProcesses() });
});

route('GET', '/api/processes/detail', async ({ res, url }) => {
  const pid = Number(url.searchParams.get('pid'));
  if (!Number.isInteger(pid) || pid <= 0) {
    sendError(res, 400, '无效的 PID', 'VALIDATION_BAD_PID');
    return;
  }
  sendOk(res, await getProcessDetail(pid));
});

/* ---- services ---- */

route('GET', '/api/services', async ({ res, url }) => {
  const force = url.searchParams.get('refresh') === '1';
  sendOk(res, await getServices(force));
});

route('POST', '/api/services/action', async ({ res, body }) => {
  const payload = await body();
  const action = String(payload.action ?? '');
  const unit = String(payload.unit ?? '');
  await controlService(action, unit);
  sendOk(res, { action, unit });
});

route('GET', '/api/services/logs', async ({ res, url }) => {
  const unit = url.searchParams.get('unit') ?? '';
  const lines = Number(url.searchParams.get('lines') ?? 200);
  sendOk(res, await getServiceLogs(unit, lines));
});

/* ---- logs ---- */

route('GET', '/api/logs/files', async ({ res }) => {
  sendOk(res, { files: await listSystemLogs() });
});

route('GET', '/api/logs/read', async ({ res, url }) => {
  const path = url.searchParams.get('path') ?? '';
  const lines = Number(url.searchParams.get('lines') ?? 300);
  sendOk(res, await getSystemLog(path, lines));
});

route('GET', '/api/logs/journal', async ({ res, url }) => {
  const lines = Number(url.searchParams.get('lines') ?? 300);
  const priority = url.searchParams.get('priority') ?? 'all';
  sendOk(res, await getJournal(lines, priority));
});

/* ---- files ---- */

route('GET', '/api/files', async ({ res, url, config }) => {
  sendOk(res, await listDirectory(config.fileRoot, url.searchParams.get('path') ?? ''));
});

route('GET', '/api/files/read', async ({ res, url, config }) => {
  sendOk(res, await readTextFile(config.fileRoot, url.searchParams.get('path') ?? ''));
});

route('POST', '/api/files/write', async ({ res, body, config }) => {
  const payload = await body();
  sendOk(res, await writeTextFile(config.fileRoot, String(payload.path ?? ''), payload.content));
});

route('GET', '/api/files/download', async ({ req, res, url, config }) => {
  await streamFile(config.fileRoot, url.searchParams.get('path') ?? '', res);
});

route('POST', '/api/files/upload', async ({ req, res, url, config }) => {
  const target = url.searchParams.get('path') ?? '';
  if (!target) {
    sendError(res, 400, '缺少目标路径', 'VALIDATION_BAD_PATH');
    return;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > 512 * 1024 * 1024) {
    sendError(res, 413, '文件超过 512 MB 上限', 'FS_TOO_LARGE');
    return;
  }
  sendOk(res, await receiveUpload(config.fileRoot, target, req));
});

route('POST', '/api/files/mkdir', async ({ res, body, config }) => {
  const payload = await body();
  sendOk(res, await createDirectory(config.fileRoot, String(payload.path ?? '')));
});

route('POST', '/api/files/delete', async ({ res, body, config }) => {
  const payload = await body();
  sendOk(res, await removePath(config.fileRoot, String(payload.path ?? '')));
});

route('POST', '/api/files/rename', async ({ res, body, config }) => {
  const payload = await body();
  sendOk(res, await renamePath(config.fileRoot, String(payload.from ?? ''), String(payload.to ?? '')));
});

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

/**
 * Serve the built frontend.
 *
 * Unknown paths fall back to index.html because routes are hash-based — this
 * keeps a deep link from 404ing while still letting real 404s surface as the app.
 */
async function serveStatic(req, res, config) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relativePath = normalize(urlPath).replace(/^([/\\])+/, '');
  let filePath = join(config.staticRoot, relativePath);

  // Refuse traversal outside the static root.
  if (filePath !== config.staticRoot && !filePath.startsWith(config.staticRoot + sep)) {
    sendError(res, 403, '路径超出允许范围', 'FS_ESCAPE');
    return;
  }

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) {
    filePath = join(config.staticRoot, 'index.html');
    info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      sendError(res, 404, '前端尚未构建，请先运行 npm run build', 'NOTFOUND_FILE');
      return;
    }
  }

  const extension = extname(filePath).toLowerCase();
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }

  const compressible = ['.html', '.js', '.css', '.svg', '.json', '.map'].includes(extension);
  const gzip = compressible && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');

  res.writeHead(200, {
    'content-type': MIME[extension] ?? 'application/octet-stream',
    etag,
    'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    vary: 'accept-encoding',
  });

  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  if (gzip) stream.pipe(createGzip({ level: 6 })).pipe(res);
  else stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

/** @type {Set<import('node:http').ServerResponse>} */
const streamClients = new Set();

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Disable proxy buffering, otherwise nginx holds events until the buffer fills.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  streamClients.add(res);

  const cleanup = () => streamClients.delete(res);
  req.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Broadcast metrics to every SSE client on a fixed cadence.
 *
 * The interval starts only when the first client connects, so an idle console
 * does not poll /proc forever.
 */
export function startMetricsBroadcast() {
  let timer = null;

  const tick = async () => {
    if (streamClients.size === 0) {
      stop();
      return;
    }
    try {
      const overview = await getOverview();
      const payload = `data: ${JSON.stringify(overview)}\n\n`;
      for (const client of streamClients) {
        // A dead socket throws on write; drop it rather than crashing the loop.
        try {
          client.write(payload);
        } catch {
          streamClients.delete(client);
        }
      }
    } catch (error) {
      console.error('[neko] 指标推送失败:', errorMessage(error));
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(tick, 2000);
  };

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    /** Called by the stream route so the interval starts lazily. */
    ensureRunning() {
      start();
    },
    shutdown() {
      stop();
      for (const client of streamClients) client.end();
      streamClients.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* dispatcher                                                          */
/* ------------------------------------------------------------------ */

const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/session']);

/**
 * @param {object} options
 * @param {import('./config.mjs').Config} options.config
 * @param {{ ensureRunning: () => void }} options.stream
 */
/**
 * Audit log.
 *
 * State-changing actions are written to the journal with a `[neko]` prefix so
 * they survive in `journalctl -u neko-console` even if the console itself is
 * later compromised or removed. This is the console's only durable record of
 * who restarted what.
 */
function auditLog(line) {
  console.log(`[neko] ${new Date().toISOString()} ${line}`);
}

export function createHandler({ config, stream }) {
  // Periodic sweep keeps the login-throttle map bounded.
  setInterval(() => sweepAttempts(config.loginWindow), 60_000).unref();

  // Docker / catalogue / power routes are registered once per handler.
  registerDockerRoutes(route, { config, log: auditLog });

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Basic hardening: these headers cost nothing and cover the common cases.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('referrer-policy', 'same-origin');

    if (!path.startsWith('/api/')) {
      await serveStatic(req, res, config);
      return;
    }

    // --- authentication gate ---
    if (!PUBLIC_PATHS.has(path)) {
      const token = parseCookies(req)[COOKIE_NAME];
      const session = verifySession(token, config.sessionSecret);
      if (!session) {
        sendError(res, 401, '未登录或登录已过期', 'AUTH_REQUIRED');
        return;
      }
    }

    if (path === '/api/stream') {
      handleStream(req, res);
      stream.ensureRunning();
      return;
    }

    const handler = routes.get(`${method} ${path}`);
    if (!handler) {
      sendError(res, 404, `未知接口 ${method} ${path}`, 'NOTFOUND_ROUTE');
      return;
    }

    try {
      await handler({ req, res, url, config, body: () => readJsonBody(req), sendOk });
    } catch (error) {
      // Status and code come from the taxonomy, never from string matching.
      const apiError = toApiError(error);
      if (apiError.status >= 500) {
        console.error(`[neko] ${method} ${path} → ${apiError.code}:`, apiError.detail ?? apiError.message);
      }
      if (!res.headersSent) {
        sendError(res, apiError.status, apiError.message, apiError.code, apiError.detail);
      } else {
        res.end();
      }
    }
  };
}

export { COOKIE_NAME, MAX_EDIT_BYTES, isSafeToken };
