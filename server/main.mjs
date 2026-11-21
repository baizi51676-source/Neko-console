#!/usr/bin/env node
/**
 * Neko-console server entry point.
 *
 * Usage:
 *   node server/main.mjs            start
 *   node server/init.mjs            create /etc/neko-console/config.json
 *
 * The server is intentionally a single process with no dependencies: one Node
 * binary, one config file, one port.
 */
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { createHandler, startMetricsBroadcast } from './http.mjs';
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
    console.log(`  终端功能 : ${config.enableTerminal ? '已启用' : '已禁用'}`);
    console.log('');
  });

  // Graceful shutdown so in-flight SSE clients are closed instead of dangling.
  const shutdown = (signal) => {
    console.log(`\n[neko] 收到 ${signal}，正在关闭…`);
    stream.shutdown();
    server.close(() => process.exit(0));
    // Do not wait forever on a stuck socket.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
