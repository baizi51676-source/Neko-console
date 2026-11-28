# Neko-console 部署与运维

面向单台 Linux 服务器的轻量管理面板。无外部依赖（一个 Node 二进制 + 一个
SQLite 文件），所有特权操作都经过审计。

---

## 一、快速安装

```sh
git clone https://github.com/baizi51676-source/Neko-console.git
cd Neko-console
sudo ./deploy/install.sh
```

安装脚本会：创建 `neko` 用户、部署文件、生成配置、安装 systemd 单元与
**特权辅助程序**、启动服务。默认只监听 `127.0.0.1:8737`。

首次登录用 `sudo -u neko node /opt/neko-console/server/init.mjs` 生成管理员密码。

---

## 二、架构：为什么需要「特权辅助程序」

这是本项目最容易误解的部分，值得先讲清楚。

### 2.1 约束

服务以 `neko` 用户运行，systemd 单元里启用了：

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
```

`NoNewPrivileges` 会让 **sudo 完全失效** —— 这不是障碍，而是设计目标：
即使控制台被攻破，攻击者也拿不到 root。

但有些操作必须 root 才能做：

| 操作 | 为什么需要 root |
|---|---|
| `nginx -t` | 要写 `/var/log/nginx/*.log` 与 `/run/nginx.pid`，还要 bind :80 |
| `systemctl reload nginx` | 要向 master 进程发信号 |
| `mysql` / `mysqldump` | root 账号用 `auth_socket`，只有 OS root 能连 |
| `certbot` | 要写 `/etc/letsencrypt` |

### 2.2 三种被否决的方案

| 方案 | 为什么放弃 |
|---|---|
| 去掉 `NoNewPrivileges` + 配置无密码 sudo | 给 Node 进程一条通用 root 路径，攻破控制台 = 攻破主机 |
| polkit 规则 | Ubuntu 22.04 是 polkit **0.105**，JS 规则要 0.106+；`.pkla` 无法按 unit 名过滤 |
| setuid 脚本 | Linux 内核**忽略脚本的 setuid 位**（只对二进制生效） |

### 2.3 实际方案：systemd path unit + root 辅助脚本

```
控制台(neko)                  systemd                   辅助程序(root)
    │                            │                          │
    ├─ 写请求文件 ───────────────►│                          │
    │  /var/lib/neko-console/    │ 检测到文件变化            │
    │      helper/xxx-request    ├─ 启动 unit ─────────────►│
    │                            │                          ├─ 校验动作白名单
    │                            │                          ├─ 执行特权操作
    │                            │                          ├─ 写结果文件
    ├─ 读结果文件 ◄──────────────┼──────────────────────────┤
    │  helper/xxx-result.json    │                          │
```

关键点：**控制台只写一个词，root 脚本决定这个词的含义**。

- 请求文件内容受严格限制（`test` / `reload` / `status`，或经正则校验的数据库名）
- 辅助脚本在 `/usr/local/lib/` 下，root 所有，控制台的 `ReadWritePaths` 覆盖不到
- 因此即使控制台被完全攻破，攻击者也只能请求那几个固定动作

安装位置：

```
/usr/local/lib/neko-console/bin/nginx-helper
/usr/local/lib/neko-console/bin/db-helper
/usr/local/lib/neko-console/bin/cert-helper
/etc/systemd/system/neko-{nginx,db,cert}-helper.{service,path}
```

检查状态：

```sh
systemctl status neko-nginx-helper.path neko-db-helper.path neko-cert-helper.path
```

如果某个功能报「辅助单元未响应」，通常是 path unit 被 systemd 的启动频率限制
卡住了：

```sh
sudo systemctl reset-failed neko-nginx-helper.path
sudo systemctl restart neko-nginx-helper.path
```

`install_helpers` 已经写入 `StartLimitBurst=30 / 60s`，正常使用不会触发。

---

## 三、网站管理（M1）

### 3.1 托管目录

控制台**不碰** `/etc/nginx/sites-enabled/` 下你手写的文件。它有自己的目录：

```
/etc/nginx/neko-sites/*.conf        ← 控制台完全拥有
/etc/nginx/conf.d/neko-sites.conf   ← 一行 include
```

面板里删站点只会删 `neko-sites/` 下带 marker 的文件。手写文件即使同名也不会被删。

### 3.2 改动流程

每次保存都走同一条路径：

1. 从数据库渲染配置 → 原子写入（临时文件 + rename）
2. `nginx -t` 校验
3. **失败**：恢复上一版文件 → 再次 reload → 报错返回
4. **成功**：reload

第 3 步是这套设计的关键：一个写错的上游端口是「校验错误」，不是「服务中断」。

原子写入同样重要 —— 直接写活动配置文件时，nginx 可能在写入中途 reload 并读到
截断的文件，导致整个 nginx 挂掉。

### 3.3 能力边界

| 支持 | 不支持 |
|---|---|
| 反向代理到 `127.0.0.1:port` | 代理到远程主机（会变成开放中继） |
| 静态目录 + autoindex | PHP / FastCGI |
| 多域名（逗号分隔） | 自定义 `location` 正则 |

上游必须是 loopback：这是「本机反代」工具，不是通用 nginx 配置编辑器。

---

## 四、SSL 证书（M3）

### 4.1 webroot 而非 --nginx

用 `certbot certonly --webroot`，不用 `--nginx` 插件。原因：插件会**改写 server
block**，与控制台自己的渲染逻辑打架（两个写者，一个文件）。webroot 只往
`/var/www/neko-acme/` 丢一个验证文件，nginx 配置完全不动。

申请前确认：

- 域名 A 记录已指向本机公网 IP
- 80 端口可从外网访问（NAT 后需要端口映射）
- 该域名的站点已存在，或至少 nginx 在运行

### 4.2 续期不在 Node 里

面板**不**在 Node 进程内跑定时器。续期由 systemd timer 完成：

```sh
sudo systemctl enable --now neko-cert-renew.timer
systemctl list-timers neko-cert-renew.timer
```

理由：控制台停机期间，进程内定时器不会执行，证书就过期了。systemd 的
`Persistent=true` 能补跑错过的执行。

面板只做**巡检**（读取 `notAfter`，剩余天数 ≤14 天报警），不触发续期 ——
刷个页面不应该产生副作用。

---

## 五、数据库管理（M2）

### 5.1 范围

只做生命周期：

- 建数据库 + 建一个**只对该库有全部权限**的账号
- 删数据库（需要 `force=true`，UI 有二次确认）

**不做**表结构浏览、SQL 执行、导入导出。需要这些请用 phpMyAdmin（约 50 MB）
或 pgAdmin —— 把一个 SQL 控制台放在 Web 登录后面，攻击面比整个面板都大。

### 5.2 密码不落库

密码在 Node 侧生成，通过辅助程序传给 MySQL，然后**只在响应里返回一次**。
控制台的 SQLite 里没有任何数据库密码。丢了就重置，面板无法帮你找回。

---

## 六、计划任务（M4）

### 6.1 不用 crontab

任务存在 SQLite，Node 内每 10 秒 tick 一次检查。理由：

- 执行记录与输出能显示在面板里，crontab 做不到
- 命令不会变成磁盘上的 shell 字符串，没有 crontab 注入面

### 6.2 命令形式

`command` 字段**不接受 shell 字符串**，只有两种：

1. **内置动作**：`action.backup.run`、`action.ssl.renew-check`、
   `action.nginx.reload`、`action.site.probe`
2. **白名单脚本**：`/etc/neko-console/jobs/` 下的文件名（不能含斜杠）

两者都通过 `execFile` 直接执行，**不经过 shell**。所以下面这些都无效：

```sh
backup.sh; rm -rf /        # 分号被当作文件名的一部分 → 找不到文件
action.backup.run | cat    # 同理
$(whoami)                  # 同理
```

### 6.3 调度表达式

- `every:<秒>` —— 最小 60 秒（更短容易把主机压垮）
- 5 段 cron —— 支持 `*`、数字、范围 `1-5`、步进 `*/10`、列表 `1,3,5`、月份/星期英文名

不支持 `L`、`W`、`#`、`@reboot`：静默误读一个不支持的语法，比直接拒绝更糟。

---

## 七、备份（M5）

### 7.1 两类归档

| 类型 | 方式 | 一致性保证 |
|---|---|---|
| 数据库 | `mysqldump --single-transaction` → gzip | 不锁表的 InnoDB 快照 |
| 站点 | `tar -czf`，排除 `node_modules` / `.git` | 不跟随符号链接 |

每个归档计算 SHA-256，存进 `backups` 表。面板的「校验」按钮重新算一遍比对 ——
没人验证过的备份只是希望，不是备份。

### 7.2 保留策略

按类型分别保留最近 5 份（`NEKO_BACKUP_KEEP` 可改）。分开计数，避免高频的数据库
备份把站点备份挤掉。

### 7.3 不做离线上传

备份都在本机 `/var/backups/neko-console`。**磁盘故障时备份一起丢失。**
重要数据请自行：

```sh
rsync -av /var/backups/neko-console/ user@remote:/backups/
# 或
rclone sync /var/backups/neko-console/ remote:neko-backups
```

把备份上传做成面板功能需要凭据管理、断点续传、带宽控制，那是另一个项目。

---

## 八、权限清单

安装脚本会创建：

```sh
# 数据与备份
/var/lib/neko-console/          neko:neko  750   # SQLite + helper 目录
/var/backups/neko-console/      neko:neko  750
/etc/neko-console/jobs/         root:root  755   # 任务脚本

# nginx 托管
/etc/nginx/neko-sites/          neko:neko  755
/etc/nginx/conf.d/              root:neko  775   # 写 include 文件
/var/www/neko-acme/             root:root  755   # ACME 验证

# 辅助程序
/usr/local/lib/neko-console/bin/*  root:root  755
```

---

## 九、systemd 单元

`neko-console.service` 的沙箱设置：

```ini
NoNewPrivileges=true       # 禁止提权（这是 sudo 失效的原因，也是设计目标）
ProtectSystem=strict       # / 只读
ProtectHome=true           # 隐藏 /home
PrivateTmp=true
ReadWritePaths=/var/lib/neko-console /var/backups/neko-console \
               /etc/nginx/neko-sites /etc/nginx/conf.d \
               /var/www/neko-acme /etc/letsencrypt \
               /etc/neko-console /etc/systemd/system
Environment=HOME=/var/lib/neko-console/home   # Docker CLI 需要可读的 HOME
Environment=NEKO_DB_FILE=/var/lib/neko-console/neko.sqlite
```

> `HOME` 那行不是多余的：`ProtectHome=true` 会隐藏 `/home`，而 Docker CLI 要读
> `$HOME/.docker/config.json`。不设这行，所有 `docker compose` 命令都会失败，
> 报的还是误导性的「权限不足」。

---

## 十、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 网站保存报「nginx 配置校验失败」 | 配置本身有错，已回滚 | 看响应里的 `detail` 字段 |
| 网站保存报「辅助单元未响应」 | path unit 被限流或未启用 | `systemctl reset-failed neko-nginx-helper.path` |
| 数据库页显示引擎不可用 | MySQL 未启动或 helper 未装 | `systemctl status mysql neko-db-helper.path` |
| 证书申请失败 | 域名未解析 / 80 端口不通 | 先 `curl -I http://你的域名/.well-known/acme-challenge/test` |
| 计划任务不执行 | 服务时间不对或任务已暂停 | `timedatectl`、面板里看「已启用」 |
| 备份失败 | 目标目录不可写 | `ls -ld /var/backups/neko-console` |
| 磁盘 100% 但看着没大文件 | snap loopback 占用 | 面板已过滤 `/snap`，用 `df -h` 确认真实分区 |

---

## 十一、升级

```sh
cd Neko-console && git pull
sudo ./deploy/install.sh    # 会重装文件与 helper，保留配置和数据库
```

SQLite schema 用 `CREATE TABLE IF NOT EXISTS`，升级不会丢数据。新增字段需要手写
`ALTER TABLE`（见 `server/db/index.mjs`）。

---

## 十二、卸载

```sh
sudo ./deploy/install.sh --uninstall
```

会停服务、删 unit 与辅助程序。**不删**配置、数据库和备份 —— 那些是你的数据。
