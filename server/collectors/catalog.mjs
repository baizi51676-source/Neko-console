import { ApiError } from '../errors.mjs';
/**
 * One-click application catalogue.
 *
 * Each template is a declarative container spec. The deployer turns it into
 * either a `docker run` invocation or a generated compose file, depending on the
 * mode the user picked — so one catalogue serves both deployment styles.
 *
 * Networking: images are pulled from Docker Hub by default. Mainland-China hosts
 * frequently cannot reach it, so every template declares the mirror prefix to
 * use when the user selects the mirror source. The prefix is applied to the
 * *image reference only*; template metadata always points at the upstream
 * project so the user can verify what they are installing.
 */

/** Regional registry mirrors, applied as a prefix to the image name. */
export const REGISTRY_SOURCES = [
  {
    id: 'github',
    label: 'GitHub 直链 / 官方源',
    hint: '直连 Docker Hub，速度取决于线路',
    imagePrefix: '',
    // GitHub-hosted compose/asset downloads go through the same choice.
    githubMirror: 'https://raw.githubusercontent.com',
  },
  {
    id: 'dockerproxy',
    label: 'Docker Proxy（国内）',
    hint: 'dockerproxy.net 镜像，无需登录',
    imagePrefix: 'dockerproxy.net/',
    githubMirror: 'https://raw.gitmirror.com',
  },
  {
    id: '1panel',
    label: '1Panel 镜像（国内）',
    hint: 'docker.1panel.live，社区常用',
    imagePrefix: 'docker.1panel.live/',
    githubMirror: 'https://raw.gitmirror.com',
  },
  {
    id: 'daocloud',
    label: 'DaoCloud（国内）',
    hint: 'docker.m.daocloud.io，稳定但可能限速',
    imagePrefix: 'docker.m.daocloud.io/',
    githubMirror: 'https://raw.gitmirror.com',
  },
];

export function findSource(id) {
  return REGISTRY_SOURCES.find((source) => source.id === id) ?? REGISTRY_SOURCES[0];
}

/**
 * Apply a mirror prefix to an image reference.
 *
 * `nginx:latest` -> `dockerproxy.net/nginx:latest`, but an already-qualified
 * reference (`ghcr.io/foo/bar`) also gets the prefix, because those hosts are
 * equally unreachable from some networks.
 */
export function resolveImage(image, sourceId) {
  const source = findSource(sourceId);
  if (!source.imagePrefix) return image;
  // Do not double-prefix if the reference already points at that mirror.
  if (image.startsWith(source.imagePrefix)) return image;
  return `${source.imagePrefix}${image}`;
}

/**
 * @typedef {object} TemplateVariable
 * @property {string} key       Environment variable or placeholder name
 * @property {string} label     Human label shown in the form
 * @property {string} [default] Default value
 * @property {boolean} [secret] Mask in the UI and generate if empty
 * @property {boolean} [required]
 * @property {string} [hint]
 */

/**
 * @typedef {object} TemplatePort
 * @property {number} host      Host port
 * @property {number} container Container port
 * @property {string} [protocol]
 * @property {string} [label]
 */

/**
 * @typedef {object} TemplateVolume
 * @property {string} host
 * @property {string} container
 * @property {boolean} [readOnly]
 */

/**
 * @typedef {object} AppTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {string} description
 * @property {string} image
 * @property {TemplatePort[]} ports
 * @property {TemplateVolume[]} volumes
 * @property {TemplateVariable[]} env
 * @property {string[]} [extraArgs]
 * @property {string} [homepage]
 * @property {string} [docs]
 * @property {string} [note]
 */

/** @type {AppTemplate[]} */
export const TEMPLATES = [
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'Web 服务',
    description: '高性能反向代理与静态资源服务器',
    image: 'nginx:alpine',
    ports: [{ host: 8080, container: 80, label: 'HTTP' }],
    volumes: [{ host: '/srv/nginx/html', container: '/usr/share/nginx/html' }],
    env: [],
    homepage: 'https://nginx.org',
    docs: 'https://hub.docker.com/_/nginx',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: '数据库',
    description: 'MySQL 8.0，含持久化数据卷与初始口令',
    image: 'mysql:8.0',
    ports: [{ host: 3306, container: 3306, label: 'MySQL' }],
    volumes: [{ host: '/srv/mysql/data', container: '/var/lib/mysql' }],
    env: [
      { key: 'MYSQL_ROOT_PASSWORD', label: 'root 密码', secret: true, required: true },
      { key: 'MYSQL_DATABASE', label: '初始数据库名', default: 'app' },
    ],
    homepage: 'https://www.mysql.com',
    docs: 'https://hub.docker.com/_/mysql',
    note: '首次启动约需 30 秒完成初始化，期间健康检查会失败。',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: '数据库',
    description: 'PostgreSQL 16，含持久化数据卷',
    image: 'postgres:16-alpine',
    ports: [{ host: 5432, container: 5432, label: 'PostgreSQL' }],
    volumes: [{ host: '/srv/postgres/data', container: '/var/lib/postgresql/data' }],
    env: [
      { key: 'POSTGRES_PASSWORD', label: 'postgres 密码', secret: true, required: true },
      { key: 'POSTGRES_USER', label: '用户名', default: 'postgres' },
      { key: 'POSTGRES_DB', label: '初始数据库名', default: 'postgres' },
    ],
    homepage: 'https://www.postgresql.org',
    docs: 'https://hub.docker.com/_/postgres',
  },
  {
    id: 'redis',
    name: 'Redis',
    category: '数据库',
    description: '内存键值存储，适合缓存与会话',
    image: 'redis:7-alpine',
    ports: [{ host: 6379, container: 6379, label: 'Redis' }],
    volumes: [{ host: '/srv/redis/data', container: '/data' }],
    env: [],
    extraArgs: ['--appendonly', 'yes'],
    homepage: 'https://redis.io',
    docs: 'https://hub.docker.com/_/redis',
  },
  {
    id: 'mongo',
    name: 'MongoDB',
    category: '数据库',
    description: '文档数据库 7.0',
    image: 'mongo:7',
    ports: [{ host: 27017, container: 27017, label: 'MongoDB' }],
    volumes: [{ host: '/srv/mongo/data', container: '/data/db' }],
    env: [
      { key: 'MONGO_INITDB_ROOT_USERNAME', label: 'root 用户名', default: 'admin' },
      { key: 'MONGO_INITDB_ROOT_PASSWORD', label: 'root 密码', secret: true, required: true },
    ],
    homepage: 'https://www.mongodb.com',
    docs: 'https://hub.docker.com/_/mongo',
  },
  {
    id: 'minio',
    name: 'MinIO',
    category: '存储',
    description: 'S3 兼容的对象存储服务',
    image: 'minio/minio:latest',
    ports: [
      { host: 9000, container: 9000, label: 'S3 API' },
      { host: 9001, container: 9001, label: '控制台' },
    ],
    volumes: [{ host: '/srv/minio/data', container: '/data' }],
    env: [
      { key: 'MINIO_ROOT_USER', label: '管理员账号', default: 'minioadmin' },
      { key: 'MINIO_ROOT_PASSWORD', label: '管理员密码', secret: true, required: true },
    ],
    extraArgs: ['server', '/data', '--console-address', ':9001'],
    homepage: 'https://min.io',
    docs: 'https://hub.docker.com/r/minio/minio',
  },
  {
    id: 'portainer',
    name: 'Portainer',
    category: '管理面板',
    description: 'Docker 图形化管理界面（注意与本控制台功能重叠）',
    image: 'portainer/portainer-ce:latest',
    ports: [{ host: 9443, container: 9443, label: 'HTTPS 控制台' }],
    volumes: [
      { host: '/var/run/docker.sock', container: '/var/run/docker.sock' },
      { host: '/srv/portainer/data', container: '/data' },
    ],
    env: [],
    homepage: 'https://www.portainer.io',
    docs: 'https://hub.docker.com/r/portainer/portainer-ce',
    note: '挂载 docker.sock 等于把宿主机 Docker 控制权交给该容器，请仅在可信环境使用。',
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: '监控',
    description: '自托管的可用性监控与告警',
    image: 'louislam/uptime-kuma:1',
    ports: [{ host: 3001, container: 3001, label: 'Web' }],
    volumes: [{ host: '/srv/uptime-kuma/data', container: '/app/data' }],
    env: [],
    homepage: 'https://github.com/louislam/uptime-kuma',
    docs: 'https://hub.docker.com/r/louislam/uptime-kuma',
  },
  {
    id: 'gitea',
    name: 'Gitea',
    category: '开发工具',
    description: '轻量自托管 Git 服务',
    image: 'gitea/gitea:1',
    ports: [
      { host: 3000, container: 3000, label: 'Web' },
      { host: 2222, container: 22, label: 'SSH' },
    ],
    volumes: [{ host: '/srv/gitea/data', container: '/data' }],
    env: [
      { key: 'GITEA__server__SSH_PORT', label: 'SSH 对外端口', default: '2222' },
      { key: 'GITEA__server__ROOT_URL', label: '站点 URL', default: 'http://localhost:3000/' },
    ],
    homepage: 'https://gitea.io',
    docs: 'https://hub.docker.com/r/gitea/gitea',
  },
  {
    id: 'n8n',
    name: 'n8n',
    category: '自动化',
    description: '可视化工作流自动化平台',
    image: 'n8nio/n8n:latest',
    ports: [{ host: 5678, container: 5678, label: 'Web' }],
    volumes: [{ host: '/srv/n8n/data', container: '/home/node/.n8n' }],
    env: [
      { key: 'N8N_BASIC_AUTH_ACTIVE', label: '启用基础认证', default: 'true' },
      { key: 'N8N_BASIC_AUTH_USER', label: '认证用户名', default: 'admin' },
      { key: 'N8N_BASIC_AUTH_PASSWORD', label: '认证密码', secret: true },
    ],
    homepage: 'https://n8n.io',
    docs: 'https://hub.docker.com/r/n8nio/n8n',
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    category: '站点',
    description: 'WordPress + SQLite，单容器即可运行',
    image: 'wordpress:latest',
    ports: [{ host: 8081, container: 80, label: 'Web' }],
    volumes: [{ host: '/srv/wordpress/html', container: '/var/www/html' }],
    env: [],
    homepage: 'https://wordpress.org',
    docs: 'https://hub.docker.com/_/wordpress',
    note: '未连接外部数据库，首次进入安装向导时请选择 SQLite 或自行配置 MySQL。',
  },
  {
    id: 'whoogle',
    name: 'Whoogle',
    category: '工具',
    description: '自托管、无广告的 Google 搜索代理',
    image: 'benbusby/whoogle-search:latest',
    ports: [{ host: 5000, container: 5000, label: 'Web' }],
    volumes: [],
    env: [],
    homepage: 'https://github.com/benbusby/whoogle-search',
    docs: 'https://hub.docker.com/r/benbusby/whoogle-search',
  },
];

export function findTemplate(id) {
  return TEMPLATES.find((template) => template.id === id);
}

/**
 * Validate and normalise a user-supplied deployment spec.
 *
 * Everything here is attacker-controlled once the API is reachable, so the
 * returned object is rebuilt field by field rather than spread from input.
 */
export function normalizeSpec(input, sourceId, templateId) {
  const template = templateId ? findTemplate(templateId) : null;
  const name = String(input.name ?? template?.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) {
    throw new ApiError('VALIDATION_BAD_NAME', '容器名只能包含小写字母、数字、下划线、点和中划线');
  }

  const imageRef = String(input.image ?? template?.image ?? '').trim();
  if (!/^[A-Za-z0-9._/:@-]{1,255}$/.test(imageRef)) throw new ApiError('VALIDATION_BAD_IMAGE', '无效的镜像名');

  const ports = (Array.isArray(input.ports) ? input.ports : template?.ports ?? []).map((port) => {
    const host = Number(port.host);
    const container = Number(port.container);
    if (!Number.isInteger(host) || host < 1 || host > 65535) throw new ApiError('VALIDATION_BAD_PORT', `无效的宿主端口: ${port.host}`);
    if (!Number.isInteger(container) || container < 1 || container > 65535) throw new ApiError('VALIDATION_BAD_PORT', `无效的容器端口: ${port.container}`);
    const protocol = port.protocol === 'udp' ? 'udp' : 'tcp';
    return { host, container, protocol, label: String(port.label ?? '') };
  });

  const volumes = (Array.isArray(input.volumes) ? input.volumes : template?.volumes ?? []).map((volume) => {
    const host = String(volume.host ?? '').trim();
    const container = String(volume.container ?? '').trim();
    // Reject path traversal and shell metacharacters; a bind source is a host
    // path and must look like one (or be a named volume).
    if (host && !/^(\/|\.\/)[A-Za-z0-9._\-/:@+ ]{1,240}$/.test(host) && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(host)) {
      throw new ApiError('VALIDATION_BAD_PATH', `无效的宿主路径: ${host}`);
    }
    if (!container.startsWith('/')) throw new ApiError('VALIDATION_BAD_PATH', `容器内路径必须是绝对路径: ${container}`);
    return { host, container, readOnly: Boolean(volume.readOnly) };
  });

  const envInput = input.env && typeof input.env === 'object' ? input.env : {};
  const env = Object.entries(envInput)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => ({ key, value: String(value ?? '') }));

  const extraArgs = (Array.isArray(input.extraArgs) ? input.extraArgs : template?.extraArgs ?? [])
    .map((arg) => String(arg))
    .filter((arg) => arg.length > 0 && arg.length < 200);

  const restart = ['no', 'always', 'unless-stopped', 'on-failure'].includes(String(input.restart))
    ? String(input.restart)
    : 'unless-stopped';

  return {
    name,
    image: resolveImage(imageRef, sourceId),
    originalImage: imageRef,
    ports,
    volumes,
    env,
    extraArgs,
    restart,
    network: input.network ? String(input.network).replace(/[^a-zA-Z0-9_.-]/g, '') : null,
  };
}

/** Build the `docker run` argument vector for a spec. */
export function buildRunArgs(spec) {
  const args = ['run', '-d', '--name', spec.name, '--restart', spec.restart];
  for (const port of spec.ports) args.push('-p', `${port.host}:${port.container}/${port.protocol}`);
  for (const volume of spec.volumes) {
    if (!volume.host) continue;
    args.push('-v', `${volume.host}:${volume.container}${volume.readOnly ? ':ro' : ''}`);
  }
  for (const entry of spec.env) args.push('-e', `${entry.key}=${entry.value}`);
  if (spec.network) args.push('--network', spec.network);
  args.push(spec.image, ...spec.extraArgs);
  return args;
}

/** Render a compose file for a spec (used by the compose deployment mode). */
export function buildComposeFile(spec, projectName) {
  const lines = [`services:`, `  ${spec.name}:`, `    image: ${spec.image}`, `    container_name: ${spec.name}`, `    restart: ${spec.restart}`];

  if (spec.ports.length > 0) {
    lines.push('    ports:');
    for (const port of spec.ports) {
      lines.push(`      - "${port.host}:${port.container}${port.protocol === 'udp' ? '/udp' : ''}"`);
    }
  }
  if (spec.volumes.length > 0) {
    lines.push('    volumes:');
    for (const volume of spec.volumes) {
      if (!volume.host) continue;
      lines.push(`      - "${volume.host}:${volume.container}${volume.readOnly ? ':ro' : ''}"`);
    }
  }
  if (spec.env.length > 0) {
    lines.push('    environment:');
    for (const entry of spec.env) {
      // Quote values: they may contain spaces, `$` or `#` which YAML would eat.
      lines.push(`      ${entry.key}: ${JSON.stringify(entry.value)}`);
    }
  }
  if (spec.extraArgs.length > 0) {
    lines.push('    command:');
    for (const arg of spec.extraArgs) lines.push(`      - ${JSON.stringify(arg)}`);
  }
  if (spec.network) {
    lines.push('    networks:', `      - ${spec.network}`);
    lines.push('networks:', `  ${spec.network}:`, '    external: true');
  }
  return `${lines.join('\n')}\n`;
}

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export { NAME_RE as CONTAINER_NAME_RE };
