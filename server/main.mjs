#!/usr/bin/env node
/**
 * Neko-console server entry point.
 *
 * Usage:
 *   node server/main.mjs            start
 *   node server/init.mjs            create /etc/neko-console/config.json
 *
 * The server is intentionally a single process with no dependencies: one Node
 * binary, one config file, one port, one SQLite database.
 */
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { createHandler, startMetricsBroadcast } from './http.mjs';
import { openDatabase, closeDatabase } from './db/index.mjs';
import { startScheduler, stopScheduler } from './lib/jobs.mjs';
import { ensureManagedDir } from './lib/nginx.mjs';
import { ensureAcmeRoot } from './lib/certbot.mjs';
import { runFullBackup } from './lib/backup.mjs';
import { IS_LINUX } from './util.mjs';

function main() {
  if (!IS_LINUX) {
    console.warn('[neko] 当前不是 Linux 系统，多数采集项( /proc、systemd )将不可用，仅适合开发调试');
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`\n[neko] 启动失败: ${error.message}\n`);
    console.error('提示: 运行 `node server/init.mjs` 生成配置文件，或设置 NEKO_PASSWORD_HASH。\n');
    process.exit(1);
  }

  // --- persistence ------------------------------------------------------
  // The database must exist before anything else: the scheduler and every
  // handler read from it.
  try {
    openDatabase(config.databaseFile);
  } catch (error) {
    console.error(`\n[neko] 无法打开数据库 ${config.databaseFile}: ${error.message}\n`);
    process.exit(1);
  }

  // --- expose the backup runner to the job action registry ---------------
  // The job module cannot import backup.mjs directly without a cycle (backup
  // imports the db, jobs is imported by the db's consumers). Handing it over
  // through a global is the least-bad option and is set before any job can run.
  globalThis.__nekoBackup = { runFullBackup };

  // --- privileged bootstrap --------------------------------------------
  // Both are idempotent. Failures are warnings, not fatal: a host without nginx
  // should still be able to run the rest of the console.
  ensureManagedDir()
    .then((result) => {
      if (result.created) console.log(`[neko] 已创建 nginx 托管目录 ${result.dir}`);
    })
    .catch((error) => console.warn(`[neko] nginx 托管目录初始化失败: ${error.message}`));

  ensureAcmeRoot().catch((error) => {
    console.warn(`[neko] ACME 目录初始化失败: ${error.message}`);
  });

  // --- scheduler --------------------------------------------------------
  const stopJobs = startScheduler({
    log: (line) => console.log(`[neko] ${line}`),
  });

  // --- HTTP -------------------------------------------------------------
  const stream = startMetricsBroadcast();
  const handler = createHandler({ config, stream });

  const server = config.tlsCert && config.tlsKey
    ? createServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) }, handler)
    : createHttpServer(handler);

  server.listen(config.port, config.host, () => {
    const scheme = config.tlsCert ? 'https' : 'http';
    console.log('');
    console.log('  Neko-console');
    console.log(`  ${scheme}://${config.host}:${config.port}`);
    console.log('');
    console.log(`  静态目录 : ${config.staticRoot}`);
    console.log(`  文件管理 : ${config.fileRoot}`);
    console.log(`  数据库   : ${config.databaseFile}`);
    console.log(`  终端功能 : ${config.enableTerminal ? '已启用' : '已禁用'}`);
    console.log('');
  });

  // Graceful shutdown so in-flight SSE clients are closed and the scheduler stops
  // cleanly instead of being killed mid-job.
  const shutdown = (signal) => {
    console.log(`\n[neko] 收到 ${signal}，正在关闭…`);
    stopJobs();
    stream.shutdown();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    // Do not wait forever on a stuck socket.
    setTimeout(() => {
      closeDatabase();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
