# 部署指南

面向 **x86_64 / amd64** 的 Linux 服务器（Ubuntu、Debian、CentOS Stream、Rocky、Fedora 等）。
其他架构（arm64 等）未经测试。

---

## 一、快速安装

```sh
sudo ./deploy/install.sh
```

脚本会依次完成：

1. 检查 Node 20+、systemd 与 root 权限
2. 创建系统用户 `neko`（无登录 shell）
3. 安装到 `/opt/neko-console`
4. 构建前端（`dist/`）
5. 交互式生成 `/etc/neko-console/config.json`（权限 640）
6. 安装 polkit 规则（允许 `neko` 用户启停服务）
7. 安装并启动 systemd 服务

安装完成后：

```sh
systemctl status neko-console
journalctl -u neko-console -f
```

卸载（保留配置与数据）：

```sh
sudo ./deploy/install.sh --uninstall
```

---

## 二、手动安装

```sh
# 1. 依赖
sudo apt install -y nodejs npm        # 或 dnf install nodejs
node -v                               # 需 >= 20

# 2. 用户与目录
sudo useradd --system --no-create-home --shell /usr/sbin/nologin neko
sudo mkdir -p /opt/neko-console /etc/neko-console /var/lib/neko-console/files
sudo chown -R neko:neko /var/lib/neko-console

# 3. 代码与构建
sudo cp -r . /opt/neko-console
cd /opt/neko-console
sudo npm install && sudo npm run build

# 4. 配置（交互式，会写入 /etc/neko-console/config.json）
sudo NEKO_CONFIG_DIR=/etc/neko-console node server/init.mjs

# 5. 服务
sudo cp deploy/neko-console.service /etc/systemd/system/
sudo cp deploy/polkit.rules /etc/polkit-1/rules.d/49-neko-console.rules
sudo systemctl daemon-reload
sudo systemctl enable --now neko-console
```

---

## 三、配置

配置文件 `/etc/neko-console/config.json`（权限应保持 `640` 或 `600`）：

```json
{
  "port": 8737,
  "host": "127.0.0.1",
  "username": "admin",
  "passwordHash": "scrypt$16384$8$1$...",
  "sessionSecret": "随机 base64",
  "sessionTtl": 43200,
  "fileRoot": "/var/lib/neko-console/files",
  "staticRoot": "/opt/neko-console/dist",
  "loginMaxAttempts": 8,
  "loginWindow": 900,
  "enableTerminal": true
}
```

环境变量优先级高于配置文件，可在 systemd unit 里覆盖：

| 变量 | 说明 |
|---|---|
| `NEKO_PORT` | 监听端口 |
| `NEKO_HOST` | 监听地址（`127.0.0.1` 仅本机 / `0.0.0.0` 对外） |
| `NEKO_USERNAME` | 管理员用户名 |
| `NEKO_PASSWORD_HASH` | scrypt 口令哈希 |
| `NEKO_SESSION_SECRET` | 会话签名密钥 |
| `NEKO_FILE_ROOT` | 文件管理根目录 |
| `NEKO_STATIC_ROOT` | 前端构建产物目录 |
| `NEKO_LOGIN_MAX` / `NEKO_LOGIN_WINDOW` | 登录限流次数 / 窗口秒数 |
| `NEKO_TLS_CERT` / `NEKO_TLS_KEY` | 直接启用 HTTPS 时提供证书路径 |

### 修改密码

```sh
sudo NEKO_CONFIG_DIR=/etc/neko-console node server/init.mjs   # 选择覆盖
sudo systemctl restart neko-console
```

或直接生成哈希后写入配置：

```sh
node -e "import('./server/auth.mjs').then(m => console.log(m.hashPassword('新密码')))"
```

---

## 四、反向代理（推荐）

**不要**把控制台直接暴露在公网 HTTP 上。默认配置已让它只监听 `127.0.0.1`，由反向代理负责 TLS。

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name console.example.com;

    ssl_certificate     /etc/letsencrypt/live/console.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/console.example.com/privkey.pem;

    # 认证方式是自己的一套 Cookie，不需要 HTTP Basic 之外的额外放行规则
    location / {
        proxy_pass http://127.0.0.1:8737;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 必须关闭缓冲，否则指标会攒批到达
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;

        # 文件上传
        client_max_body_size 512m;
    }
}
```

### Caddy

```caddyfile
console.example.com {
    reverse_proxy 127.0.0.1:8737 {
        flush_interval -1
    }
    request_body {
        max_size 512MB
    }
}
```

Caddy 的 `flush_interval -1` 等价于关闭缓冲，SSE 才能实时。

### 额外加固建议

- 用 `allow` / `deny` 限制来源 IP，或放到 VPN / Tailscale 之后
- 配置 fail2ban 监控 `journalctl -u neko-console` 中的登录失败
- 定期 `apt upgrade` 更新 Node 运行时

---

## 五、安全说明

这个控制台能启停服务、读写文件，**等同于一个受限的远程 shell**。请按此标准对待：

| 措施 | 实现 |
|---|---|
| 口令存储 | scrypt（N=16384, r=8, p=1），不保存明文 |
| 会话 | HMAC-SHA256 签名的 HttpOnly + SameSite=Strict Cookie，无服务端 session 文件 |
| 登录限流 | 每 IP 在窗口内超过 `loginMaxAttempts` 次即锁定至窗口结束 |
| 路径穿越 | 所有文件路径先 `path.resolve` 再校验前缀，并用 `realpath` 防止符号链接逃逸 |
| 命令注入 | 只用 `execFile`，参数从不经过 shell；服务名按白名单正则校验 |
| 进程隔离 | systemd 单元启用 `ProtectSystem=strict`、`ProtectHome`、`NoNewPrivileges` 等 |
| 权限最小化 | 服务以 `neko` 用户运行；polkit 规则只放行 systemd 的 start/stop/restart/reload |

已知边界：

- **文件管理器的工作范围**是 `fileRoot`，不是整个文件系统。要访问 `/etc` 之类的路径，需显式把 `fileRoot` 指向它，并理解随之而来的风险。
- **polkit 规则**允许 `neko` 用户启停任意 systemd 服务。如果这不合适，删除 `/etc/polkit-1/rules.d/49-neko-console.rules`，服务管理功能会退化为只读。
- **本控制台没有多用户与审计日志**。它是单管理员工具；需要多人协作或操作审计时，应放在带审计的跳板机后。

---

## 六、故障排查

| 现象 | 排查 |
|---|---|
| 启动即退出，提示「尚未设置管理员密码」 | 配置没被读到。检查 `/etc/neko-console` 的**属组**：服务以 `neko` 运行，目录必须是 `root:neko` 且权限 `750`，文件 `root:neko 640`。若目录是 `root:root 750`，进程连 `cd` 进去都做不到，只会看到「未设置密码」。修复：`sudo chown root:neko /etc/neko-console /etc/neko-console/config.json` |
| 日志页空白 / 提示 journald 不可用 | `neko` 用户不在 `systemd-journal` 组。修复：`sudo usermod -aG systemd-journal neko && sudo systemctl restart neko-console` |
| 打开页面 404 / 白屏 | 前端未构建：`cd /opt/neko-console && npm run build` |
| 页面能开但一直显示「正在连接服务器…」 | 反代未关闭 buffering，或 Cookie 的 `Secure` 与 HTTP 访问不匹配 |
| 指标不动、图表空白 | 打开浏览器控制台看 `/api/stream` 是否 401；再看 `journalctl -u neko-console` |
| 服务启停报「Access denied」 | polkit 规则未生效：确认文件位置，并 `systemctl reload polkit` |
| 登录后立刻掉线 | 若走 HTTP 且配置了 TLS 证书，Cookie 带 `Secure` 会被丢弃；改用 HTTPS 或去掉证书配置 |
| 磁盘显示 100% 但实际没满 | 已修复：`/snap/*` 的 loopback 挂载会被过滤。若仍异常，检查是否有其他 squashfs 挂载 |

查看服务日志：

```sh
journalctl -u neko-console -n 100 --no-pager
```

---

## 七、Docker 与电源功能

### 7.1 授权 Docker 访问

控制台以 `neko` 用户运行，需要加入 `docker` 组才能读写容器：

```sh
sudo usermod -aG docker neko
sudo systemctl restart neko-console      # 组成员变更需重启进程
```

验证：`sudo -u neko docker ps` 应能列出容器。

### 7.2 systemd 沙箱与 HOME

`neko-console.service` 启用了 `ProtectHome=true`，这会隐藏 `/home`。而 Docker CLI 需要读取
`$HOME/.docker/config.json`，否则报：

```
WARNING: Error loading config file: open /home/neko/.docker/config.json: permission denied
unknown shorthand flag: 'f' in -f
```

因此 unit 里显式把 `HOME` 指向一个可写路径：

```ini
Environment=HOME=/var/lib/neko-console/home
```

对应目录需存在并属于服务用户：

```sh
sudo mkdir -p /var/lib/neko-console/home/.docker
sudo chown -R neko:neko /var/lib/neko-console/home
```

> 这是实际部署中踩到的坑：`docker info` 单独执行正常，但在沙箱内就会因为读不到配置而
> 让所有 `docker compose` 命令失败，错误信息还指向「权限不足」，容易误判。

### 7.3 一键安装的镜像源

面板提供四个源，仅替换镜像名的 registry 前缀，模板元数据始终指向上游：

| 源 | 前缀 |
|---|---|
| GitHub 直链 / 官方 | （无，直连 Docker Hub） |
| Docker Proxy | `dockerproxy.net/` |
| 1Panel 镜像 | `docker.1panel.live/` |
| DaoCloud | `docker.m.daocloud.io/` |

生成的 compose 项目存放于 `/var/lib/neko-console/stacks/<项目名>/docker-compose.yml`，
可在面板内编辑并重新 apply。

### 7.4 电源操作的防护

重启/关机需要**重新输入账号密码**，而不只是点击确认：

- 已登录的会话 cookie 不足以关机，避免会话被盗后变成拒绝服务
- 操作后进入 20 秒倒计时，期间可在侧边栏取消
- 有未完成的 systemd 任务时直接拒绝
- 动作执行前写入 journal，便于事后审计

### 7.5 错误码

所有 API 错误返回稳定机器码，便于脚本判断：

```json
{ "ok": false, "error": "宿主端口已被占用，请改用其他端口", "code": "DOCKER_PORT_CONFLICT", "detail": "..." }
```

常用码：`AUTH_REQUIRED`、`VALIDATION_BAD_NAME`、`DOCKER_PORT_CONFLICT`、
`DOCKER_IMAGE_UNAVAILABLE`、`DOCKER_NO_PERMISSION`、`FS_ESCAPE`、`POWER_UNAVAILABLE`。
完整列表见 `server/errors.mjs`。