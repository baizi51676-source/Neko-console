#!/usr/bin/env bash
#
# Neko-console installer for Linux (x86_64 / amd64).
#
# What it does:
#   1. checks prerequisites (Node 20+, systemd, root)
#   2. creates a dedicated `neko` system user
#   3. installs the app to /opt/neko-console
#   4. writes config to /etc/neko-console (mode 600)
#   5. installs and starts the systemd unit
#
# Usage:
#   sudo ./deploy/install.sh              # install from the current directory
#   sudo ./deploy/install.sh --uninstall
#
set -euo pipefail

APP_DIR=/opt/neko-console
CONFIG_DIR=/etc/neko-console
DATA_DIR=/var/lib/neko-console
SERVICE=neko-console
UNIT_PATH=/etc/systemd/system/${SERVICE}.service
POLKIT_PATH=/etc/polkit-1/rules.d/49-neko-console.rules
SERVICE_USER=neko

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "请使用 root 运行：sudo $0"
}

# The console is developed for amd64 Linux; there is no arm64 build guarantee
# because a couple of collectors assume /proc layout that is stable there.
check_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) : ;;
    *) warn "当前架构为 $arch，本项目仅在 x86_64 上验证过，继续可能有兼容问题。" ;;
  esac
}

check_node() {
  command -v node >/dev/null 2>&1 || die "未找到 node。请先安装 Node.js 20 或更高版本（如 apt install nodejs npm）。"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node.js 版本过低（当前 v$major），需要 20+。"
  log "Node.js $(node -v)"
}

check_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd，本安装脚本依赖它。"
}

create_user() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "创建系统用户 $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
  else
    log "用户 $SERVICE_USER 已存在"
  fi

  # Reading journald requires membership of this group. Without it every log
  # endpoint returns "insufficient permissions" and the UI looks broken.
  if getent group systemd-journal >/dev/null 2>&1; then
    usermod -aG systemd-journal "$SERVICE_USER"
    log "已将 $SERVICE_USER 加入 systemd-journal 组（用于读取日志）"
  else
    warn "未找到 systemd-journal 组，日志功能可能不可用"
  fi
}

install_files() {
  log "安装到 $APP_DIR"
  mkdir -p "$APP_DIR"
  # Copy the app, excluding dev-only artefacts.
  tar -C "$(dirname "$0")/.." \
      --exclude=node_modules --exclude=.git --exclude=dist \
      --exclude='.test-files' --exclude='*.log' \
      -cf - . | tar -C "$APP_DIR" -xf -
  chown -R root:root "$APP_DIR"
}

build_frontend() {
  log "构建前端（可能需要几分钟）"
  cd "$APP_DIR"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --prod=false --frozen-lockfile 2>/dev/null || pnpm install
    pnpm run build
  else
    npm install --no-audit --no-fund
    npm run build
  fi
  [ -f "$APP_DIR/dist/index.html" ] || die "构建失败：$APP_DIR/dist/index.html 不存在"
}

setup_config() {
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  # The service runs as $SERVICE_USER but reads config as root-owned. The
  # directory must therefore belong to the service *group*, otherwise the
  # process cannot even traverse into it and reports "password not set".
  chown root:"$SERVICE_USER" "$CONFIG_DIR"
  chmod 750 "$CONFIG_DIR"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

  if [ -f "$CONFIG_DIR/config.json" ]; then
    log "检测到现有配置，保留（如需重置请先删除 $CONFIG_DIR/config.json）"
    return
  fi

  log "初始化配置（交互式）"
  cd "$APP_DIR"
  NEKO_CONFIG_DIR="$CONFIG_DIR" node server/init.mjs
  chown root:"$SERVICE_USER" "$CONFIG_DIR/config.json"
  chmod 640 "$CONFIG_DIR/config.json"

  # Point the file manager at the dedicated data directory.
  node -e "
    const fs = require('fs');
    const p = '$CONFIG_DIR/config.json';
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.fileRoot = '$DATA_DIR/files';
    c.staticRoot = '$APP_DIR/dist';
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  "
  mkdir -p "$DATA_DIR/files"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
}

install_polkit() {
  # Without this, `systemctl restart foo` from the service user is denied. The
  # rule is scoped to the neko user and to lifecycle verbs only — it does not
  # grant blanket root.
  log "安装 polkit 规则（允许 neko 用户管理服务启停）"
  mkdir -p "$(dirname "$POLKIT_PATH")"
  cat > "$POLKIT_PATH" <<'EOF'
polkit.addRule(function(action, subject) {
  if (subject.user != "neko") return;
  var allowed = ["org.freedesktop.systemd1.manage-units"];
  if (allowed.indexOf(action.id) == -1) return;
  var verbs = ["start", "stop", "restart", "reload"];
  var verb = action.lookup("verb");
  if (verb && verbs.indexOf(verb) == -1) return;
  return polkit.Result.YES;
});
EOF
  chmod 644 "$POLKIT_PATH"
  systemctl reload polkit 2>/dev/null || true
}

install_unit() {
  log "安装 systemd 服务"
  install -m 644 "$(dirname "$0")/neko-console.service" "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$SERVICE"
  systemctl restart "$SERVICE"
  sleep 2
  systemctl is-active --quiet "$SERVICE" \
    && log "服务已启动" \
    || { systemctl status "$SERVICE" --no-pager || true; die "服务启动失败，请查看 journalctl -u $SERVICE"; }
}

uninstall() {
  log "卸载 Neko-console"
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_PATH" "$POLKIT_PATH"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$APP_DIR"
  warn "已保留配置 $CONFIG_DIR 与数据 $DATA_DIR；如需彻底清除请手动删除。"
}

main() {
  require_root
  case "${1:-}" in
    --uninstall) uninstall; exit 0 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    "") : ;;
    *) die "未知参数：$1" ;;
  esac

  check_arch
  check_node
  check_systemd
  create_user
  install_files
  build_frontend
  setup_config
  install_polkit
  install_unit

  local port
  port="$(node -p "require('$CONFIG_DIR/config.json').port")"
  cat <<EOF

  ✅ 安装完成

     访问地址:  http://127.0.0.1:${port}
     （默认仅监听本机，建议用 Nginx/Caddy 反代并启用 HTTPS，
       参考 docs/deploy.md「反向代理」一节）

     配置文件:  ${CONFIG_DIR}/config.json
     数据目录:  ${DATA_DIR}/files
     服务管理:  systemctl {status|restart|stop} ${SERVICE}
     查看日志:  journalctl -u ${SERVICE} -f

EOF
}

main "$@"
