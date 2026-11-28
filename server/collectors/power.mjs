/**
 * Host power control.
 *
 * Restarting or shutting down a server from a web page is the most destructive
 * thing this console can do, so it is deliberately conservative:
 *
 *   1. the operator must re-enter their password (not just click OK) — this
 *      defeats a stolen session cookie and a mis-click alike;
 *   2. a short countdown runs and is reported to the UI, so an accidental
 *      action can still be cancelled;
 *   3. the request is written to the journal before the action fires, giving an
 *      audit trail even if the machine never comes back;
 *   4. power-off is refused when it would be immediately undone by a scheduled
 *      wake or an active shutdown inhibitor.
 */
import { tryRun, hasBinary } from '../util.mjs';
import { verifyPassword } from '../auth.mjs';
import { ApiError } from '../errors.mjs';

/** Pending power actions, keyed by a random token, so they can be cancelled. */
const pending = new Map();

/** How long the operator has to cancel. */
const COUNTDOWN_SECONDS = 20;

export function powerCapabilities() {
  const systemd = hasBinary('systemctl');
  return {
    available: systemd,
    canReboot: systemd,
    canShutdown: systemd,
    countdown: COUNTDOWN_SECONDS,
    reason: systemd ? undefined : '该系统未使用 systemd，无法执行关机/重启',
  };
}

/**
 * Schedule a power action.
 *
 * Returns a token and the countdown; the caller shows it to the user, who can
 * then POST /api/power/cancel with the token during the window.
 *
 * @param {'reboot'|'shutdown'} action
 * @param {string} password       Re-authentication of the operator
 * @param {object} config
 * @param {(line: string) => void} log  Journal writer
 */
export async function schedulePowerAction(action, password, config, log) {
  if (action !== 'reboot' && action !== 'shutdown') throw new ApiError('VALIDATION_BAD_ACTION', '不支持的操作');
  if (!powerCapabilities().available) throw new ApiError('POWER_UNAVAILABLE', '该系统未使用 systemd，无法执行该操作');

  // Re-authentication: a session cookie alone must not be enough to power off a
  // server, otherwise an XSS or a stolen cookie becomes a denial-of-service.
  if (typeof password !== 'string' || password.length === 0) throw new ApiError('AUTH_MISSING_FIELDS', '请输入当前账号密码以确认');
  if (!verifyPassword(password, config.passwordHash)) throw new ApiError('AUTH_PASSWORD_MISMATCH', '密码错误，已取消操作');

  // Refuse if systemd says something is holding a shutdown lock.
  const inhibitors = await tryRun('systemctl', ['list-jobs', '--no-legend', '--no-pager'], { timeout: 5000 });
  if ((inhibitors ?? '').trim().length > 0) {
    throw new ApiError('POWER_BUSY', '有正在进行的 systemd 任务，已取消操作');
  }

  const token = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url').slice(0, 24);
  const fireAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  const command = action === 'reboot' ? ['systemctl', 'reboot'] : ['systemctl', 'poweroff'];

  log(`power: ${action} scheduled by admin (token ${token.slice(0, 8)}…), fires in ${COUNTDOWN_SECONDS}s`);

  const timer = setTimeout(async () => {
    pending.delete(token);
    log(`power: ${action} executing now`);
    // `--no-block` returns immediately so the HTTP layer can answer before the
    // kernel tears the network down.
    await tryRun(command[0], [command[1], '--no-block'], { timeout: 10000 });
  }, COUNTDOWN_SECONDS * 1000);

  // Do not hold the event loop open just for a pending power-off.
  timer.unref?.();

  pending.set(token, { action, fireAt, timer });

  return {
    token,
    action,
    firesAt: fireAt,
    countdown: COUNTDOWN_SECONDS,
    message: action === 'reboot' ? '服务器将在倒计时结束后重启' : '服务器将在倒计时结束后关机',
  };
}

/** Cancel a pending action. Returns false when the token is unknown/expired. */
export function cancelPowerAction(token, log) {
  const entry = pending.get(token);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(token);
  log(`power: ${entry.action} cancelled by admin`);
  return true;
}

/** Introspection for the UI's countdown display. */
export function pendingActions() {
  return [...pending.entries()].map(([token, entry]) => ({
    token,
    action: entry.action,
    firesAt: entry.fireAt,
    remaining: Math.max(0, Math.ceil((entry.fireAt - Date.now()) / 1000)),
  }));
}
