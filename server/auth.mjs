/**
 * Authentication.
 *
 * Design constraints:
 *   - no session files on disk (a restart should not strand users, and a file is
 *     one more thing to protect), so the cookie is a signed, self-describing
 *     token instead;
 *   - constant-time comparison wherever a secret is involved;
 *   - throttling is per-IP and in-memory, which is right for a single-admin
 *     console. A clustered deployment would need a shared store.
 */
import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/**
 * Hash a password into `scrypt$N$r$p$salt$hash`.
 *
 * scrypt rather than PBKDF2 because it is memory-hard, which makes GPU/ASIC
 * cracking meaningfully more expensive for the same cost to us.
 *
 * @param {string} password
 * @returns {string}
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a password against a stored hash, in constant time.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    expected = Buffer.from(hashRaw, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = scryptSync(password, salt, expected.length, { N, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------------ */
/* signed session tokens                                               */
/* ------------------------------------------------------------------ */

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * @param {string} username
 * @param {string} secret
 * @param {number} ttlSeconds
 * @returns {string}
 */
export function createSession(username, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: username, iat: now, exp: now + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Validate a session token.
 *
 * The signature is checked before the payload is parsed, so a forged token
 * cannot reach the JSON parser with attacker-controlled structure.
 *
 * @param {string | undefined} token
 * @param {string} secret
 * @returns {{ sub: string, iat: number, exp: number } | null}
 */
export function verifySession(token, secret) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/* ------------------------------------------------------------------ */
/* login throttling                                                    */
/* ------------------------------------------------------------------ */

/** @type {Map<string, { count: number, first: number, blockedUntil: number }>} */
const attempts = new Map();

/**
 * Record a failed login and report whether the caller is now blocked.
 *
 * Sliding window: the counter resets once the window elapses, so an attacker
 * cannot accumulate failures forever against a slow trickle.
 *
 * @param {string} ip
 * @param {number} maxAttempts
 * @param {number} windowSeconds
 * @returns {{ blocked: boolean, retryAfter: number }}
 */
export function registerFailure(ip, maxAttempts, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const record = attempts.get(ip);

  if (!record || now - record.first > windowMs) {
    attempts.set(ip, { count: 1, first: now, blockedUntil: 0 });
    return { blocked: false, retryAfter: 0 };
  }

  record.count += 1;
  if (record.count >= maxAttempts) {
    // Block for the remainder of the window rather than a fixed penalty, so the
    // lockout cannot be gamed by waiting briefly and retrying.
    record.blockedUntil = record.first + windowMs;
    return { blocked: true, retryAfter: Math.ceil((record.blockedUntil - now) / 1000) };
  }
  return { blocked: false, retryAfter: 0 };
}

/**
 * @param {string} ip
 * @returns {{ blocked: boolean, retryAfter: number }}
 */
export function isBlocked(ip) {
  const record = attempts.get(ip);
  if (!record) return { blocked: false, retryAfter: 0 };
  const now = Date.now();
  if (record.blockedUntil > now) {
    return { blocked: true, retryAfter: Math.ceil((record.blockedUntil - now) / 1000) };
  }
  return { blocked: false, retryAfter: 0 };
}

/** @param {string} ip */
export function clearFailures(ip) {
  attempts.delete(ip);
}

/** Periodic sweep so the map cannot grow without bound. */
export function sweepAttempts(windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000 * 2;
  for (const [ip, record] of attempts) {
    if (record.first < cutoff && record.blockedUntil < Date.now()) attempts.delete(ip);
  }
}
