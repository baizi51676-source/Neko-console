/**
 * One-off codemod: replace `throw new Error(...)` with coded `ApiError`s.
 *
 * Written as a script rather than a pile of sed-like replacements because the
 * mapping is semantic (a "not found" in the file manager is a different code
 * from a "not found" in projects) and because it has to be idempotent enough to
 * re-run after adding new throws.
 *
 * Usage: node scripts/codemod-errors.mjs [--dry]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const DRY = process.argv.includes('--dry');

/**
 * Per-file, per-message-fragment mapping to a code.
 * Order matters: the first match wins.
 */
const RULES = {
  'server/collectors/catalog.mjs': [
    ['容器名只能包含', 'VALIDATION_BAD_NAME'],
    ["'无效的镜像名'", 'VALIDATION_BAD_IMAGE'],
    ['无效的宿主端口', 'VALIDATION_BAD_PORT'],
    ['无效的容器端口', 'VALIDATION_BAD_PORT'],
    ['无效的宿主路径', 'VALIDATION_BAD_PATH'],
    ['容器内路径必须是绝对路径', 'VALIDATION_BAD_PATH'],
  ],
  'server/collectors/deploy.mjs': [
    ["'无效的镜像名'", 'VALIDATION_BAD_IMAGE'],
    ['拉取镜像失败', 'DOCKER_IMAGE_UNAVAILABLE'],
    ['已存在，请换一个名字', 'DOCKER_NAME_TAKEN'],
    ["'容器启动失败'", 'DOCKER_ACTION_FAILED'],
    ["'无效的项目名'", 'VALIDATION_BAD_NAME'],
    ['已存在且内容不同', 'DOCKER_NAME_TAKEN'],
    ["'项目不存在'", 'NOTFOUND_PROJECT'],
    ['compose 内容过大', 'VALIDATION_TOO_LARGE'],
    ['内容不像 compose 文件', 'DOCKER_COMPOSE_INVALID'],
    ['compose 校验失败', 'DOCKER_COMPOSE_INVALID'],
    ["'应用失败'", 'DOCKER_COMPOSE_FAILED'],
  ],
  'server/collectors/power.mjs': [
    ["'不支持的操作'", 'VALIDATION_BAD_ACTION'],
    ['该系统未使用 systemd', 'POWER_UNAVAILABLE'],
    ['请输入当前账号密码', 'AUTH_MISSING_FIELDS'],
    ['密码错误，已取消操作', 'AUTH_PASSWORD_MISMATCH'],
    ['有正在进行的 systemd 任务', 'POWER_BUSY'],
  ],
  'server/collectors/services.mjs': [
    ['不支持的操作', 'VALIDATION_BAD_ACTION'],
    ["'无效的服务名'", 'VALIDATION_BAD_NAME'],
    ['执行失败（可能缺少权限）', 'DOCKER_ACTION_FAILED'],
    ['不允许读取该日志文件', 'FS_LOG_FORBIDDEN'],
  ],
  'server/routes/docker.mjs': [
    ['未知的应用模板', 'NOTFOUND_TEMPLATE'],
  ],
};

/** Files that need the ApiError import added. */
const files = Object.keys(RULES);
let total = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  let next = source;
  let changed = 0;

  for (const [fragment, code] of RULES[file]) {
    // Match `throw new Error(<anything up to the closing paren>)` whose text
    // contains the fragment. The non-greedy body handles template literals.
    const pattern = new RegExp(
      `throw new Error\\(((?:[^()]|\\([^()]*\\))*?${fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^()]|\\([^()]*\\))*?)\\)`,
      'g',
    );
    next = next.replace(pattern, (_all, args) => {
      changed += 1;
      return `throw new ApiError('${code}', ${args.trim()})`;
    });
  }

  // Add the import once, right after the last top-level import line.
  if (changed > 0 && !next.includes("from '../errors.mjs'")) {
    const lines = next.split('\n');
    let insertAt = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (/^import .* from ['"].+['"];?\s*$/.test(lines[index])) insertAt = index + 1;
      else if (/^import\s*\{/.test(lines[index])) {
        // Multi-line import: find its closing line.
        for (let inner = index; inner < lines.length; inner += 1) {
          if (/from ['"].+['"];?\s*$/.test(lines[inner])) {
            insertAt = inner + 1;
            index = inner;
            break;
          }
        }
      }
    }
    const relative = file.split('/').length > 2 ? '../errors.mjs' : './errors.mjs';
    lines.splice(insertAt, 0, `import { ApiError } from '${relative}';`);
    next = lines.join('\n');
  }

  if (changed > 0) {
    total += changed;
    console.log(`${DRY ? '[dry] ' : ''}${file}: ${changed} replacement(s)`);
    if (!DRY) await writeFile(file, next, 'utf8');
  }
}

console.log(`\n${DRY ? '[dry run] would replace' : 'replaced'} ${total} throw(s)`);
