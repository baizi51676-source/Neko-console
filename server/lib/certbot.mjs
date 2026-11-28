/**
 * SSL certificates via certbot webroot.
 *
 * Webroot rather than `--nginx`: the nginx plugin rewrites the server blocks
 * itself, which would fight the console's own rendering (two writers, one file).
 * Webroot only drops a challenge file into a directory that all our sites already
 * serve, so nginx is never modified by certbot.
 *
 * Renewal is deliberately *not* scheduled from inside Node. A long-running Node
 * process is the wrong place for a monthly task — it dies with the console, it
 * misses renewals during downtime, and it duplicates work systemd already does
 * correctly. Instead the console installs a systemd timer, and separately
 * *inspects* expiry for the UI.
 */
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../errors.mjs';
import { run, tryRun } from '../util.mjs';
import { writeAtomic } from './atomic.mjs';

const LIVE_DIR = '/etc/letsencrypt/live';
/** Shared webroot; every generated site block serves this path. */
export const ACME_ROOT = '/var/www/neko-acme';
const RENEW_UNITS = '/etc/systemd/system';
/** Days-left threshold below which the UI warns. */
export const EXPIRY_WARN_DAYS = 14;

/* ------------------------------------------------------------------ */
/* helper transport                                                    */
/* ------------------------------------------------------------------ */

const HELPER_DIR = '/var/lib/neko-console/helper';
const CERT_REQUEST = `${HELPER_DIR}/cert-request.json`;
const CERT_RESULT = `${HELPER_DIR}/cert-result.json`;

/**
 * Send one request to the privileged certificate helper and wait for the answer.
 *
 * The nonce makes a repeated identical request register as a file change so
 * systemd re-fires the path unit.
 *
 * @param {{ op: 'issue'|'renew'|'list', domains?: string[], lineage?: string }} request
 */
async function callCertHelper(request) {
  await rm(CERT_RESULT, { force: true }).catch(() => {});
  await writeAtomic(CERT_REQUEST, JSON.stringify({ ...request, nonce: Date.now() }), { mode: 0o644 });

  // Certificate issuance talks to the ACME server, so allow generous time.
  const deadline = Date.now() + 300000;
  let raw = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    raw = await readFile(CERT_RESULT, 'utf8').catch(() => null);
    if (raw !== null) break;
  }
  if (raw === null) {
    await tryRun('systemctl', ['reset-failed', 'neko-cert-helper.path'], { timeout: 10000 });
    await tryRun('systemctl', ['start', 'neko-cert-helper.path'], { timeout: 15000 });
    throw new ApiError(
      'DOCKER_ACTION_FAILED',
      '证书辅助程序未响应',
      '请确认 deploy/neko-cert-helper.path 与 .service 已安装并启用',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('DOCKER_ACTION_FAILED', '证书辅助程序返回了无法解析的结果');
  }
  if (!parsed.ok) {
    throw new ApiError(
      'DOCKER_ACTION_FAILED',
      String(parsed.message ?? '证书操作失败'),
      '请确认：域名已解析到本机、80 端口可从公网访问、且站点已使用该域名。',
    );
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ensure the ACME webroot exists and is writable by certbot (root).
 *
 * A directory that already exists with the right owner is left alone, so this is
 * safe to call on every issuance.
 */
export async function ensureAcmeRoot() {
  await mkdir(join(ACME_ROOT, '.well-known', 'acme-challenge'), { recursive: true, mode: 0o755 });
  // certbot runs as root; the directory only needs to be readable by nginx.
  await run('chown', ['-R', 'root:root', ACME_ROOT], { timeout: 10000 }).catch(() => {});
  return ACME_ROOT;
}

/**
 * Read a certificate's expiry without opening the DER by hand.
 *
 * `openssl x509 -enddate` is the one tool guaranteed to exist wherever certbot
 * is installed, and its output format is stable across versions.
 *
 * @param {string} lineage
 */
export async function certificateInfo(lineage) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(lineage)) throw new ApiError('VALIDATION_BAD_NAME', '无效的证书名');
  const fullchain = join(LIVE_DIR, lineage, 'fullchain.pem');
  if (!existsSync(fullchain)) return null;

  const enddate = await tryRun('openssl', ['x509', '-in', fullchain, '-noout', '-enddate'], { timeout: 12000 });
  if (!enddate) return null;

  const match = enddate.match(/notAfter=(.+)$/m);
  if (!match) return null;
  const expiresAt = new Date(match[1].trim());
  if (Number.isNaN(expiresAt.getTime())) return null;

  const notBeforeRaw = await tryRun('openssl', ['x509', '-in', fullchain, '-noout', '-startdate'], { timeout: 12000 });
  const issuedAt = notBeforeRaw?.match(/notBefore=(.+)$/m)?.[1]?.trim();

  const domains = await tryRun('openssl', ['x509', '-in', fullchain, '-noout', '-text'], { timeout: 12000 });
  const subject = domains?.match(/Subject:.*?CN\s*=\s*([^\n,]+)/)?.[1]?.trim() ?? lineage;
  const alt = domains?.match(/DNS:([^\n]+)/)?.[1];

  const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86400000);

  return {
    lineage,
    path: fullchain,
    subject,
    altNames: alt ? alt.split(/,\s*/).map((entry) => entry.trim()).filter(Boolean) : [],
    expiresAt: expiresAt.toISOString(),
    issuedAt: issuedAt ? new Date(issuedAt).toISOString() : null,
    daysLeft,
    expiringSoon: daysLeft <= EXPIRY_WARN_DAYS,
    expired: daysLeft < 0,
  };
}

/** Every lineage present on the host. */
export async function listCertificates() {
  if (!existsSync(LIVE_DIR)) return [];
  const entries = await readdir(LIVE_DIR).catch(() => []);
  const certs = [];
  for (const entry of entries) {
    const info = await certificateInfo(entry).catch(() => null);
    if (info) certs.push(info);
  }
  return certs.sort((a, b) => a.daysLeft - b.daysLeft);
}

/* ------------------------------------------------------------------ */
/* issuance                                                            */
/* ------------------------------------------------------------------ */

/**
 * Issue (or reinstall) a certificate for a set of hostnames.
 *
 * `--webroot` rather than `--nginx`: the nginx plugin rewrites server blocks
 * itself, which would fight the console's own rendering (two writers, one file).
 * Webroot only drops a challenge file into a directory all our sites already
 * serve, so nginx is never modified by certbot.
 *
 * certbot runs as root, so the work goes through the privileged certificate
 * helper (see deploy/cert-helper.sh); this process only writes a request and
 * reads the answer.
 *
 * @param {string[]} domains
 * @param {(message: string, level?: string) => void} [log]
 */
export async function issueCertificate(domains, log = () => {}) {
  const list = domains.map((domain) => String(domain).trim()).filter(Boolean);
  if (list.length === 0) throw new ApiError('VALIDATION_FAILED', '请至少提供一个域名');
  for (const domain of list) {
    if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
      throw new ApiError('VALIDATION_FAILED', `无效的域名: ${domain}`);
    }
  }

  await ensureAcmeRoot();
  log(`向 Let's Encrypt 申请证书: ${list.join(', ')}`);

  const result = await callCertHelper({ op: 'issue', domains: list });

  const lineage = String(result.lineage ?? list[0]);
  const info = await certificateInfo(lineage).catch(() => null);
  if (!info) {
    // A fresh issuance is not readable yet only if certbot exited oddly; report
    // the helper's message rather than inventing a certificate.
    throw new ApiError('DOCKER_ACTION_FAILED', '证书已申请但无法读取', String(result.message ?? ''));
  }
  log(`证书已签发，有效期至 ${info.expiresAt}`, 'success');
  return { ...info, output: String(result.message ?? '') };
}

/** Ask certbot to renew a single lineage now (used by the "renew" button). */
export async function renewCertificate(lineage) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(lineage)) throw new ApiError('VALIDATION_BAD_NAME', '无效的证书名');
  const result = await callCertHelper({ op: 'renew', lineage });
  return { ok: true, lineage, output: String(result.message ?? '') };
}

/* ------------------------------------------------------------------ */
/* renewal timer                                                       */
/* ------------------------------------------------------------------ */

const RENEW_SERVICE = `[Unit]
Description=neko-console certificate renewal
Documentation=managed by neko-console

[Service]
Type=oneshot
# --deploy-hook reloads nginx only when a certificate actually changed, so a
# no-op run does not drop connections.
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
`;

const RENEW_TIMER = `[Unit]
Description=neko-console certificate renewal timer
Documentation=managed by neko-console

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
`;

/**
 * Install the systemd timer that performs renewal.
 *
 * Twice daily would be certbot's own recommendation; a single small-hours run with
 * randomised delay is enough for a single-host console and avoids waking up at a
 * predictable minute.
 */
export async function installRenewalTimer() {
  const servicePath = join(RENEW_UNITS, 'neko-cert-renew.service');
  const timerPath = join(RENEW_UNITS, 'neko-cert-renew.timer');
  await writeAtomic(servicePath, RENEW_SERVICE, { mode: 0o644 });
  await writeAtomic(timerPath, RENEW_TIMER, { mode: 0o644 });
  await run('systemctl', ['daemon-reload'], { timeout: 20000 });
  await run('systemctl', ['enable', '--now', 'neko-cert-renew.timer'], { timeout: 20000 });
  return { service: servicePath, timer: timerPath };
}

/** Timer state, for the certificate panel. */
export async function renewalTimerStatus() {
  const enabled = await tryRun('systemctl', ['is-enabled', 'neko-cert-renew.timer'], { timeout: 8000 });
  const next = await tryRun('systemctl', ['list-timers', 'neko-cert-renew.timer', '--no-pager', '--no-legend'], {
    timeout: 8000,
  });
  return {
    installed: enabled !== null && (enabled ?? '').trim() !== '',
    enabled: (enabled ?? '').trim() === 'enabled',
    next: (next ?? '').trim().split('\n')[0] ?? null,
  };
}

/**
 * Inspection result used by the dashboard.
 *
 * Read-only: it reports what is expiring but never triggers a renewal, because a
 * UI refresh must not have side effects.
 */
export async function certificateHealth() {
  const certs = await listCertificates();
  const expiring = certs.filter((cert) => cert.expiringSoon);
  const expired = certs.filter((cert) => cert.expired);
  return {
    certificates: certs,
    total: certs.length,
    expiringCount: expiring.length,
    expiredCount: expired.length,
    warnDays: EXPIRY_WARN_DAYS,
    timer: await renewalTimerStatus(),
  };
}

export { stat };
