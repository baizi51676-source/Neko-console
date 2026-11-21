# Neko-console

面向 **Linux 服务器（x86_64）** 的轻量 Web 控制台：实时监控、进程、systemd 服务、日志与文件管理。

前端基于 [Aneko](https://github.com/baizi51676-source/Aneko) 界面模板，后端是 **零依赖** 的 Node 服务 —— 整台机器只需要一个 `node`，不需要数据库、不需要额外 npm 包。

![status](https://img.shields.io/badge/arch-x86__64-blue) ![node](https://img.shields.io/badge/node-%3E%3D20-green)

---

## 功能

| 模块 | 说明 |
|---|---|
| **总览** | CPU / 内存 / 磁盘 / 负载 / 网络吞吐，SSE 每 2 秒推送；含 2 分钟趋势图与温度、运行时长 |
| **进程** | 全量进程列表，按 CPU / 内存 / PID / 名称排序与搜索，可查看命令、可执行文件、工作目录、环境变量（敏感值打码） |
| **服务** | systemd 单元列表，按运行状态筛选，支持启动 / 停止 / 重启 / 查看 journal 日志 |
| **日志** | journald（可按级别过滤）或系统日志文件（syslog / messages / kern / auth…），支持关键词过滤与自动刷新 |
| **文件** | 在配置的根目录内浏览、编辑、上传、下载、新建目录、删除；含路径穿越与符号链接逃逸防护 |
| **外观** | 6 套主题预设、强调色、字体、圆角、动效强度、毛玻璃，本地持久化 |

所有数据来自 `/proc`、`/sys`、`systemctl`、`journalctl` —— **不依赖 `top`/`free`/`df` 等命令的文本输出**，因此不受发行版与语言环境影响。

---

## 技术栈

- **前端**：React 19 · Vite · Tailwind CSS 4 · motion · lucide-react（全部 MIT / ISC / Apache-2.0）
- **后端**：Node 20+ 原生模块，**零 npm 依赖**

## 快速开始

### 生产安装（推荐）

```sh
sudo ./deploy/install.sh
```

详见 [docs/deploy.md](docs/deploy.md)。

### 本地开发

```sh
pnpm install
pnpm build                       # 构建前端

# 生成测试口令哈希
node -e "import('./server/auth.mjs').then(m => console.log(m.hashPassword('你的密码')))"

# 启动后端（会同时托管 dist/）
NEKO_PASSWORD_HASH='scrypt$...' \
NEKO_SESSION_SECRET='dev-secret' \
NEKO_FILE_ROOT="$PWD/.files" \
pnpm start
```

打开 <http://127.0.0.1:8737>，用 `admin` + 你设置的密码登录。

> 开发时可以用 `pnpm dev` 起 Vite 热更新，同时另开一个后端；Vite 的 `server.proxy` 已把 `/api` 转发到 `127.0.0.1:8737`。

---

## 目录结构

```
server/                       零依赖后端
├── main.mjs                  入口：加载配置、启动 HTTP/HTTPS
├── init.mjs                  交互式初始化（写 /etc/neko-console/config.json）
├── config.mjs                配置加载（环境变量 > 文件 > 默认）
├── auth.mjs                  scrypt 口令、HMAC 会话、登录限流
├── http.mjs                  路由、鉴权中间件、SSE、静态托管
├── util.mjs                  execFile 封装、路径校验、ANSI 清理
└── collectors/
    ├── system.mjs            CPU / 内存 / 磁盘 / 网络 / 主机信息
    ├── processes.mjs         /proc 进程与详情
    ├── services.mjs          systemd 单元、journal、日志文件
    └── files.mjs             文件浏览/读写/上传，含逃逸防护

src/                          前端
├── lib/api.ts                API 客户端与 SSE 订阅
├── lib/format.ts             字节/百分比/时长/状态格式化
├── components/layout/        外壳、登录、会话
├── components/ui/            按钮、卡片、对话框、下拉、滑动条…
└── pages/                    总览 / 进程 / 服务 / 日志 / 文件 / 外观

deploy/
├── install.sh                安装与卸载脚本
├── neko-console.service      systemd unit（含沙箱化加固）
└── polkit.rules              允许 neko 用户启停服务的规则

docs/deploy.md                部署、反向代理、安全与排障
```

---

## 安全模型

控制台可启停服务、读写文件，**按远程 shell 的标准对待**：

- 口令用 scrypt（N=16384）哈希，不存明文
- 会话是 HMAC-SHA256 签名的 HttpOnly + SameSite=Strict Cookie，服务端不落盘
- 每 IP 登录限流，超限锁定至窗口结束
- 所有文件路径经 `resolve` + `realpath` 双重校验，`../../etc/shadow` 与符号链接逃逸均被拒绝
- 所有外部命令通过 `execFile` 调用，参数不经 shell；服务名按白名单正则校验
- systemd unit 启用 `ProtectSystem=strict`、`ProtectHome`、`NoNewPrivileges`、`MemoryMax` 等

默认只监听 `127.0.0.1`，**请用 Nginx / Caddy 反代并启用 HTTPS**，不要直接暴露 HTTP 端口到公网。详见 [docs/deploy.md](docs/deploy.md) 的安全与加固章节。

---

## 平台支持

- **验证目标**：Linux x86_64（amd64），systemd 系统
- 在 Windows / macOS 上可启动，但 CPU、内存、磁盘、进程、服务、日志等采集项会返回空值 —— 仅适合前端调试
- arm64 未经测试：部分采集器假设的 `/proc` 布局在该架构上可能不同

---

## 许可

**GNU Affero General Public License v3.0 or later**（AGPL-3.0-or-later），见 [LICENSE](LICENSE)。

可以自由使用、修改、分发，包括商业用途；但若修改后作为网络服务提供给他人使用，
**必须向这些用户提供完整对应源码**（AGPL 第 13 条）。如需闭源商用，需另行取得商业授权。

LICENSE 附有一段打包例外（AGPL 第 7 节允许），允许将下列同作者的 MIT 组件与本项目
一并分发而不使其受 AGPL 约束：

- [astrbot_plugin_chat_history_archiver](https://github.com/baizi51676-source/astrbot_plugin_chat_history_archiver) — MIT
- [astrbot_plugin_multimodal_enhance](https://github.com/baizi51676-source/astrbot_plugin_multimodal_enhance) — MIT

第三方依赖与来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
