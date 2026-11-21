#!/usr/bin/env node
/**
 * Interactive initialiser: creates the config file with a properly hashed
 * password and a random session secret.
 *
 * Kept separate from main.mjs so `main` can stay side-effect free and testable,
 * and so the init step can run without the proxy of a running server.
 */
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { CONFIG_DIR, CONFIG_FILE } from './config.mjs';
import { hashPassword } from './auth.mjs';

async function prompt(question, { silent = false, fallback = '' } = {}) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (silent) {
      // Hide the typed password: readline echoes by default, so temporarily
      // override the private _writeToOutput hook.
      const rlAny = rl;
      rlAny.stdoutMuted = true;
      rlAny._writeToOutput = function writeToOutput(chunk) {
        if (rlAny.stdoutMuted) {
          // Echo only the newline so the prompt's layout stays intact.
          if (String(chunk).includes('\n')) rlAny.output.write('\n');
          return;
        }
        rlAny.output.write(chunk);
      };
    }
    const answer = await rl.question(question);
    if (silent) stdout.write('\n');
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function main() {
  console.log('\n  Neko-console 初始化\n');

  if (existsSync(CONFIG_FILE)) {
    const overwrite = await prompt(`配置文件已存在（${CONFIG_FILE}），是否覆盖？[y/N] `, { fallback: 'n' });
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消。');
      return;
    }
  }

  const username = await prompt('管理员用户名 [admin]: ', { fallback: 'admin' });

  let password = '';
  while (password.length < 8) {
    password = await prompt('管理员密码（至少 8 位）: ', { silent: true });
    if (password.length < 8) console.log('  密码太短，请重试。');
  }
  const confirm = await prompt('再次输入密码: ', { silent: true });
  if (password !== confirm) {
    console.error('\n两次输入的密码不一致，已取消。\n');
    process.exit(1);
  }

  const portRaw = await prompt('监听端口 [8737]: ', { fallback: '8737' });
  const port = Number(portRaw) || 8737;
  const host = await prompt('监听地址（0.0.0.0 表示对外，127.0.0.1 表示仅本机）[0.0.0.0]: ', {
    fallback: '0.0.0.0',
  });

  const config = {
    port,
    host,
    username,
    passwordHash: hashPassword(password),
    sessionSecret: randomBytes(32).toString('base64'),
    sessionTtl: 43200,
    fileRoot: '/var/lib/neko-console/files',
    staticRoot: '/opt/neko-console/dist',
    loginMaxAttempts: 8,
    loginWindow: 900,
    enableTerminal: true,
  };

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o750 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
  mkdirSync(config.fileRoot, { recursive: true });

  console.log(`\n  配置已写入 ${CONFIG_FILE}（权限 600）`);
  console.log(`  文件管理根目录: ${config.fileRoot}`);
  console.log('\n  启动服务:  node server/main.mjs\n');
}

main().catch((error) => {
  console.error('\n初始化失败:', error.message, '\n');
  process.exit(1);
});
