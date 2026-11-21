#!/usr/bin/env node
/**
 * Smoke test for the Neko-console API.
 *
 * Boots the server on an ephemeral port with a throwaway config, then exercises
 * every route including the security boundaries. Intended for CI and for
 * verifying a fresh checkout without a real Linux host.
 *
 * Usage: node scripts/smoke-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../server/auth.mjs';

const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'admin';
const PASS = 'smoke-test-password';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Fetch helper that keeps the session cookie. */
let cookie = '';
async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (static asset) */
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/`, { method: 'GET' });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'neko-smoke-'));
  const fileRoot = join(root, 'files');
  mkdirSync(fileRoot, { recursive: true });
  mkdirSync(join(fileRoot, 'nested'), { recursive: true });
  writeFileSync(join(fileRoot, 'hello.txt'), 'hello neko');
  writeFileSync(join(fileRoot, 'nested', 'deep.txt'), 'deep');

  const env = {
    ...process.env,
    NEKO_PORT: String(PORT),
    NEKO_HOST: '127.0.0.1',
    NEKO_USERNAME: USER,
    NEKO_PASSWORD_HASH: hashPassword(PASS),
    NEKO_SESSION_SECRET: 'smoke-secret',
    NEKO_FILE_ROOT: fileRoot,
    NEKO_STATIC_ROOT: join(process.cwd(), 'dist'),
    NEKO_CONFIG_DIR: root,
  };

  const server = spawn(process.execPath, ['server/main.mjs'], { env, stdio: 'ignore' });

  try {
    const up = await waitForServer();
    if (!up) throw new Error('服务未在超时内启动');

    console.log('\n认证');
    let res = await call('/api/overview');
    check('未登录访问受保护接口返回 401', res.status === 401, `got ${res.status}`);

    res = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, password: 'wrong' }) });
    check('错误密码返回 401', res.status === 401, `got ${res.status}`);

    res = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS }) });
    check('正确密码返回 200', res.status === 200 && res.json?.ok === true);
    check('登录后下发会话 Cookie', cookie.startsWith('neko_session='));

    res = await call('/api/auth/session');
    check('会话探测返回已认证', res.json?.data?.authenticated === true);

    console.log('\n指标');
    res = await call('/api/overview');
    check('/api/overview 返回 200', res.status === 200 && res.json?.ok);
    check('overview 含 cpu/memory/disks/host', Boolean(res.json?.data?.cpu && res.json?.data?.memory && res.json?.data?.disks && res.json?.data?.host));

    for (const endpoint of ['/api/cpu', '/api/memory', '/api/disks', '/api/network', '/api/host', '/api/processes', '/api/services']) {
      res = await call(endpoint);
      check(`${endpoint} 返回 200`, res.status === 200, `got ${res.status}`);
    }

    console.log('\n文件管理');
    res = await call('/api/files');
    check('列目录成功', res.json?.ok && Array.isArray(res.json?.data?.items));
    check('列出 hello.txt', res.json?.data?.items?.some((item) => item.name === 'hello.txt'));

    res = await call('/api/files/read?path=hello.txt');
    check('读取文件内容', res.json?.data?.content === 'hello neko');

    res = await call('/api/files/write', { method: 'POST', body: JSON.stringify({ path: 'new.txt', content: 'created' }) });
    check('写入文件', res.json?.ok === true);

    res = await call('/api/files/read?path=new.txt');
    check('写入后可读回', res.json?.data?.content === 'created');

    res = await call('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ path: 'a/b/c' }) });
    check('创建多级目录', res.json?.ok === true);

    res = await call('/api/files/rename', { method: 'POST', body: JSON.stringify({ from: 'new.txt', to: 'renamed.txt' }) });
    check('重命名文件', res.json?.ok === true);

    res = await call('/api/files/read?path=renamed.txt');
    check('重命名后可读回', res.json?.data?.content === 'created');

    res = await call('/api/files/delete', { method: 'POST', body: JSON.stringify({ path: 'renamed.txt' }) });
    check('删除文件', res.json?.ok === true);

    console.log('\n安全边界');
    for (const evil of ['../../../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '/etc/passwd', 'nested/../../../etc/hosts']) {
      res = await call(`/api/files/read?path=${encodeURIComponent(evil)}`);
      check(`路径穿越被拒: ${evil}`, res.status === 400 || res.json?.ok === false, `got ${res.status}`);
    }

    res = await call('/api/files/delete', { method: 'POST', body: JSON.stringify({ path: '' }) });
    check('拒绝删除根目录', res.status >= 400 || res.json?.ok === false);

    res = await call('/api/services/action', { method: 'POST', body: JSON.stringify({ unit: 'x; rm -rf /', action: 'restart' }) });
    check('拒绝非法服务名（命令注入）', res.status >= 400 || res.json?.ok === false);

    res = await call('/api/services/action', { method: 'POST', body: JSON.stringify({ unit: 'nginx', action: 'format-disk' }) });
    check('拒绝非法操作动词', res.status >= 400 || res.json?.ok === false);

    res = await call('/api/processes/detail?pid=abc');
    check('拒绝非法 PID', res.status === 400 || res.json?.ok === false);

    res = await call('/api/unknown/route');
    check('未知路由返回 404', res.status === 404);

    console.log('\n登出');
    res = await call('/api/auth/logout', { method: 'POST' });
    check('登出返回 200', res.json?.ok === true);
    res = await call('/api/overview');
    check('登出后受保护接口返回 401', res.status === 401, `got ${res.status}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    server.kill('SIGKILL');
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp dir, best effort */
    }
  }

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n冒烟测试异常:', error.message);
  process.exit(1);
});
