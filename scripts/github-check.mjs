import { parseRepoUrl, extractComposeService, extractDockerfileInfo, summarizeReadme } from '../server/collectors/github.mjs';

const urls = [
  'https://github.com/immich-app/immich',
  'https://github.com/owner/repo/tree/dev/sub/dir',
  'git@github.com:owner/repo.git',
  'owner/repo',
];
for (const u of urls) {
  try { console.log(JSON.stringify(parseRepoUrl(u))); } catch (e) { console.log('reject:', e.message); }
}
for (const bad of ['https://gitlab.com/a/b', 'nonsense', 'https://github.com/onlyowner']) {
  try { parseRepoUrl(bad); console.log('NOT REJECTED:', bad); } catch (e) { console.log('rejected ok:', e.message); }
}

const compose = `services:
  app:
    image: "ghcr.io/example/app:1.2"
    ports:
      - "8080:80"
      - "9090:9090/udp"
    environment:
      - TZ=Asia/Shanghai
      - DEBUG=false
`;
console.log('compose:', JSON.stringify(extractComposeService(compose)));

const df = `FROM node:20
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000
EXPOSE 8080/tcp
CMD ["node","server.js"]
`;
console.log('dockerfile:', JSON.stringify(extractDockerfileInfo(df)));

const readme = `# Cool App
[![CI](https://x/y.svg)](https://x)
![badge](https://x/b.svg)

A self-hosted photo manager with face recognition.

More details here that should be trimmed away eventually.

## Installation
run it
`;
console.log('readme:', JSON.stringify(summarizeReadme(readme)));
