/**
 * Verify the scheduler fires jobs on its own — not just manual execution.
 *
 * The module is called "planned tasks"; if jobs only run when a button is
 * clicked, the feature does not exist. This creates a minute-interval job and
 * waits long enough to observe an unattended run.
 */
import http from 'node:http';

function request(method, path, body, cookie) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 8737,
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
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      },
    );
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await request('POST', '/api/auth/login', { username: 'admin', password: 'NekoTest2026!' });
const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

// A 60s interval is the minimum the validator allows.
const created = await request(
  'POST',
  '/api/jobs',
  { name: 'scheduler-probe', schedule: 'every:60', command: 'action.ssl.renew-check', kind: 'actions' },
  cookie,
);
const job = JSON.parse(created.body).data?.job;
console.log('created job:', job?.id, job?.schedule);

if (!job) {
  console.log('could not create job:', created.body.slice(0, 200));
  process.exit(1);
}

console.log('waiting up to 100s for the scheduler to fire it with no client involvement...');

let fired = null;
const deadline = Date.now() + 100_000;
while (Date.now() < deadline) {
  await sleep(5000);
  const runs = await request('GET', `/api/jobs/runs?jobId=${job.id}`, null, cookie);
  const list = JSON.parse(runs.body).data?.runs ?? [];
  if (list.length > 0) {
    fired = list[0];
    break;
  }
  process.stdout.write('.');
}
console.log('');

if (fired) {
  const elapsed = Math.round((Date.now() - new Date(fired.started_at).getTime()) / 1000);
  console.log('automatic run recorded:', fired.started_at, '| status:', fired.status);
  console.log('output:', String(fired.output ?? '').slice(0, 100));
  console.log('elapsed since start:', elapsed + 's');
  console.log('RESULT: scheduler fires unattended ✓');
} else {
  console.log('RESULT: no automatic run within 100s ✗');
}

// Also confirm a disabled job does not fire.
const disabled = await request(
  'POST',
  '/api/jobs',
  { name: 'disabled-probe', schedule: 'every:60', command: 'action.ssl.renew-check', kind: 'actions', enabled: false },
  cookie,
);
const dJob = JSON.parse(disabled.body).data?.job;
if (dJob) {
  console.log('disabled job created, waiting 70s to confirm it stays quiet...');
  await sleep(70_000);
  const runs = await request('GET', `/api/jobs/runs?jobId=${dJob.id}`, null, cookie);
  const list = JSON.parse(runs.body).data?.runs ?? [];
  console.log('disabled job runs:', list.length, list.length === 0 ? '✓ (correctly paused)' : '✗ (ran anyway)');
  await request('POST', '/api/jobs/delete', { id: dJob.id }, cookie);
}

await request('POST', '/api/jobs/delete', { id: job.id }, cookie);
console.log('cleaned up');
