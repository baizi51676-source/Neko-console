/**
 * Verify the certificate issuance pipeline reaches Let's Encrypt.
 *
 * This host is behind NAT with no domain pointing at it, so a successful
 * issuance is impossible. What *is* testable is how far the pipeline gets:
 *
 *   HTTP route -> privileged helper -> certbot -> ACME server -> error -> result
 *
 * "Account registered" proves the console can authenticate with Let's Encrypt.
 * A subsequent DNS/HTTP validation error proves the challenge step is reached.
 * Only the final "certificate signed" step needs a real domain.
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

const login = await request('POST', '/api/auth/login', { username: 'admin', password: 'NekoTest2026!' });
const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

const domain = process.argv[2] ?? 'neko-pipeline-check.test-domain-xyz.com';
const res = await request('POST', '/api/certificates/issue', { domains: [domain] }, cookie);
const body = JSON.parse(res.body);
const text = `${body.error ?? ''} ${body.detail ?? ''}`;

console.log('status:', res.status);
console.log('message:', String(body.error ?? '').slice(0, 600).replace(/\n/g, ' | '));
console.log('');
console.log('--- pipeline evidence ---');
console.log('certbot started     :', /Saving debug log|Requesting a certificate/i.test(text));
console.log('reached ACME server :', /Account registered|Creating new order|An unexpected error/i.test(text));
console.log('challenge attempted :', /DNS problem|no valid A records|NXDOMAIN|Cannot issue|Invalid response|Timeout during connect|unauthorized/i.test(text));
if (/Account registered/i.test(text)) {
  console.log('');
  console.log('=> Let\'s Encrypt account registered: the console can authenticate with ACME.');
}
