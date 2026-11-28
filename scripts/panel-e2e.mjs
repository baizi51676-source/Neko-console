/**
 * End-to-end verification of the panel modules against the running console.
 *
 * Talks HTTP directly (no curl) so JSON bodies and cookies are unambiguous.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8737);
const USER = process.env.USER_NAME ?? 'admin';
const PASS = process.env.USER_PASS ?? 'NekoTest2026!';

let cookie = '';
let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'];
          if (setCookie) cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body ?? {});

async function main() {
  console.log('\n=== 认证 ===');
  let res = await post('/api/auth/login', { username: USER, password: PASS });
  check('登录成功', res.status === 200 && res.json?.ok === true, `status=${res.status} ${res.text.slice(0, 120)}`);

  console.log('\n=== 面板总览 ===');
  res = await get('/api/panel/status');
  check('panel/status 200', res.status === 200);
  const status = res.json?.data;
  check('nginx 已检测到', status?.nginx?.available === true, `available=${status?.nginx?.available}`);
  check('nginx 托管目录已接入', status?.nginx?.wired === true);
  check('内置动作已注册', Array.isArray(status?.actions) && status.actions.length >= 4, `count=${status?.actions?.length}`);

  console.log('\n=== M1 站点 ===');
  res = await post('/api/sites', {
    name: 'e2e-proxy',
    kind: 'proxy',
    serverNames: 'e2e.test',
    upstream: '127.0.0.1:8737',
    indexed: false,
  });
  check('创建反向代理站点', res.status === 200 && res.json?.ok === true, `${res.status} ${res.text.slice(0, 200)}`);
  const siteId = res.json?.data?.site?.id;

  res = await get('/api/sites');
  const sites = res.json?.data?.sites ?? [];
  check('站点出现在列表中', sites.some((site) => site.name === 'e2e-proxy'));
  check('站点配置已渲染', sites.find((site) => site.name === 'e2e-proxy')?.rendered === true);

  res = await get('/api/sites/test');
  check('nginx -t 通过', res.json?.data?.ok === true, res.text.slice(0, 200));

  if (siteId) {
    res = await get(`/api/sites/preview?id=${siteId}`);
    check('可预览配置', (res.json?.data?.config ?? '').includes('proxy_pass'));
  }

  console.log('\n=== M1 校验边界 ===');
  res = await post('/api/sites', { name: 'bad', kind: 'proxy', serverNames: 'a.com', upstream: '8.8.8.8:80' });
  check('拒绝非本机上游', res.json?.code === 'VALIDATION_FAILED', res.json?.code);
  res = await post('/api/sites', { name: 'bad2', kind: 'php', serverNames: 'a.com', rootPath: '/srv' });
  check('拒绝 PHP 站点', res.json?.code === 'VALIDATION_FAILED', res.json?.code);
  res = await post('/api/sites', { name: 'Bad Name!', kind: 'static', serverNames: 'a.com', rootPath: '/srv' });
  check('拒绝非法站点名', res.json?.code === 'VALIDATION_BAD_NAME', res.json?.code);

  console.log('\n=== M3 证书 ===');
  res = await get('/api/certificates');
  check('证书接口 200', res.status === 200);
  check('返回证书摘要结构', typeof res.json?.data?.total === 'number');
  res = await post('/api/certificates/issue', { domains: ['bad_domain!'] });
  check('拒绝非法域名', res.json?.ok === false);

  console.log('\n=== M2 数据库 ===');
  res = await get('/api/databases/engines');
  check('引擎探测 200', res.status === 200);
  res = await post('/api/databases/create', { engine: 'mysql', database: 'bad-name!', username: 'u' });
  check('拒绝非法数据库名', res.json?.ok === false);
  res = await post('/api/databases/drop', { engine: 'mysql', database: 'testdb' });
  check('删除需要二次确认', res.json?.code === 'VALIDATION_FAILED', res.json?.code);

  console.log('\n=== M4 计划任务 ===');
  res = await post('/api/jobs', { name: 'e2e-cert', schedule: 'every:3600', command: 'action.ssl.renew-check', kind: 'actions' });
  check('创建任务', res.status === 200 && res.json?.ok === true, res.text.slice(0, 200));
  const jobId = res.json?.data?.job?.id;

  res = await post('/api/jobs', { name: 'bad-interval', schedule: 'every:10', command: 'action.nginx.reload' });
  check('拒绝过短间隔', res.json?.ok === false);
  res = await post('/api/jobs', { name: 'bad-cron', schedule: 'nonsense', command: 'action.nginx.reload' });
  check('拒绝非法 schedule', res.json?.ok === false);
  res = await post('/api/jobs', { name: 'evil', schedule: 'every:60', command: 'rm -rf /', kind: 'script' });
  check('拒绝含空格/斜杠的命令', res.json?.ok === false);
  res = await post('/api/jobs', { name: 'unknown-action', schedule: 'every:60', command: 'action.not.real', kind: 'actions' });
  check('拒绝未知内置动作', res.json?.ok === false);

  if (jobId) {
    res = await post('/api/jobs/run', { id: jobId });
    check('立即执行任务', res.json?.data?.ok === true, res.text.slice(0, 200));
    res = await get(`/api/jobs/runs?jobId=${jobId}`);
    check('执行记录已保存', (res.json?.data?.runs ?? []).length > 0);
  }

  console.log('\n=== M5 备份 ===');
  res = await get('/api/backups');
  check('备份列表 200', res.status === 200);
  check('返回保留数量', typeof res.json?.data?.keep === 'number');

  console.log('\n=== 审计 ===');
  res = await get('/api/audit?limit=20');
  const entries = res.json?.data?.entries ?? [];
  check('审计有记录', entries.length > 0, `count=${entries.length}`);
  check('记录了 site.create', entries.some((entry) => entry.action === 'site.create'));

  console.log('\n=== 清理 ===');
  if (siteId) {
    res = await post('/api/sites/delete', { id: siteId });
    check('删除测试站点', res.json?.data?.deleted === true, res.text.slice(0, 200));
  }
  if (jobId) {
    res = await post('/api/jobs/delete', { id: jobId });
    check('删除测试任务', res.json?.data?.deleted === true);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
