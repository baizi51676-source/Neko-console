import { TEMPLATES, REGISTRY_SOURCES, resolveImage, normalizeSpec, buildRunArgs, buildComposeFile } from '../server/collectors/catalog.mjs';

console.log('templates:', TEMPLATES.length, '| registry sources:', REGISTRY_SOURCES.length);
console.log('resolve github     :', resolveImage('nginx:alpine', 'github'));
console.log('resolve dockerproxy:', resolveImage('nginx:alpine', 'dockerproxy'));

const spec = normalizeSpec(
  {
    name: 'demo-app',
    image: 'nginx:alpine',
    ports: [{ host: 8080, container: 80 }],
    volumes: [{ host: '/srv/demo', container: '/data' }],
    env: { FOO: 'bar' },
    restart: 'unless-stopped',
  },
  'github',
  'nginx',
);
console.log('run args:', buildRunArgs(spec).join(' '));
console.log('--- compose ---');
console.log(buildComposeFile(spec, 'demo-app'));

console.log('=== invalid inputs (all must be rejected) ===');
const bad = [
  { name: 'Bad Name!' },
  { name: 'ok', image: 'img; rm -rf /' },
  { name: 'ok', image: 'nginx', ports: [{ host: 99999, container: 80 }] },
  { name: 'ok', image: 'nginx', volumes: [{ host: '../../etc', container: '/x' }] },
  { name: 'ok', image: 'nginx', volumes: [{ host: '/srv', container: 'relative' }] },
];
let rejected = 0;
for (const input of bad) {
  try {
    normalizeSpec(input, 'github', null);
    console.log('  !! NOT REJECTED:', JSON.stringify(input));
  } catch (error) {
    rejected += 1;
    console.log('  rejected:', error.message.slice(0, 60));
  }
}
console.log(`\n${rejected}/${bad.length} rejected`);
