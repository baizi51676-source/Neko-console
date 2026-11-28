#!/bin/bash
# Neko-console privileged helper for database lifecycle operations.
#
# MySQL's root account on Debian/Ubuntu uses auth_socket, so only a process
# running as OS root can administer it. The console runs unprivileged inside a
# NoNewPrivileges sandbox, so — exactly like the nginx helper — it writes a
# request file and this root-owned script acts on it.
#
# SECURITY
#
# Unlike the nginx helper (three literal words), this one must carry data: a
# database name, a user name, a password. That makes it the riskiest file in the
# project, so it is deliberately paranoid:
#
#   - the request is JSON, parsed by python3 (not eval'd, not split by shell)
#   - identifiers are re-validated here, not trusted from the console:
#       database/user must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$
#   - the password is passed to mysql via stdin (a temp .cnf), never argv,
#     so it does not appear in `ps`
#   - the SQL strings are escaped for MySQL literal quoting
#   - only four operations exist; anything else exits 2
#
# The console cannot write this file (it lives outside its ReadWritePaths).

set -uo pipefail

REQ_DIR="/var/lib/neko-console/helper"
REQ_FILE="$REQ_DIR/db-request.json"
OUT_FILE="$REQ_DIR/db-result.json"
mkdir -p "$REQ_DIR"

emit() {
  local ok="$1"
  local payload="$2"
  python3 - "$ok" "$payload" "$OUT_FILE" <<'PY'
import json, sys, datetime
ok, payload, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    parsed = json.loads(payload) if payload.strip().startswith('{') else {"message": payload}
except Exception:
    parsed = {"message": payload}
with open(path, 'w') as fh:
    json.dump({"ok": ok == "true", "at": datetime.datetime.now().isoformat(), **parsed}, fh)
PY
  chmod 644 "$OUT_FILE"
}

fail() { emit false "{\"message\": $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")}"; exit 1; }

[ -f "$REQ_FILE" ] || fail "缺少请求文件"

# Parse the request with python3 and emit shell-safe assignments.
PARSED="$(python3 - "$REQ_FILE" <<'PY'
import json, sys, re, shlex
try:
    with open(sys.argv[1]) as fh:
        req = json.load(fh)
except Exception as e:
    print("PARSE_ERROR")
    sys.exit(0)

op = str(req.get("op", ""))
ident = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')

def q(v):
    # shlex.quote gives us a safe single-quoted shell token.
    return shlex.quote(str(v))

db = str(req.get("database", ""))
user = str(req.get("username", "") or "")
pw = str(req.get("password", "") or "")

if op not in ("create", "drop", "list", "ping", "dump"):
    print("BAD_OP")
    sys.exit(0)
if op in ("create", "drop", "dump") and not ident.match(db):
    print("BAD_DB")
    sys.exit(0)
if user and not ident.match(user):
    print("BAD_USER")
    sys.exit(0)

print(f"OP={q(op)}")
print(f"DB={q(db)}")
print(f"USER={q(user)}")
print(f"PW={q(pw)}")
PY
)"

case "$PARSED" in
  PARSE_ERROR) fail "请求 JSON 无法解析" ;;
  BAD_OP) fail "未知操作" ;;
  BAD_DB) fail "数据库名不合法" ;;
  BAD_USER) fail "用户名不合法" ;;
esac

eval "$PARSED"

# MySQL client invocation. The password (if any) goes in a temporary defaults
# file so it never shows up in the process list.
run_mysql() {
  local sql="$1"
  if [ -n "${PW:-}" ]; then
    local cnf
    cnf="$(mktemp)"
    chmod 600 "$cnf"
    printf '[client]\nuser=root\npassword=%s\n' "$PW" > "$cnf"
    /usr/bin/mysql --defaults-extra-file="$cnf" --batch --skip-column-names -e "$sql" 2>&1
    local code=$?
    rm -f "$cnf"
    return $code
  fi
  /usr/bin/mysql --batch --skip-column-names -e "$sql" 2>&1
}

case "$OP" in
  ping)
    OUT="$(run_mysql 'SELECT VERSION();')"
    if [ $? -eq 0 ]; then
      emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"ok","version":sys.argv[1]}))' "$OUT")"
      exit 0
    fi
    fail "MySQL 连接失败: $OUT"
    ;;
  list)
    OUT="$(run_mysql "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys');")"
    if [ $? -ne 0 ]; then fail "查询失败: $OUT"; fi
    emit true "$(python3 -c 'import json,sys;print(json.dumps({"databases":[l for l in sys.argv[1].split(chr(10)) if l]}))' "$OUT")"
    exit 0
    ;;
  create)
    OUT="$(run_mysql "CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS '$USER'@'localhost' IDENTIFIED BY '$PW'; GRANT ALL PRIVILEGES ON \`$DB\`.* TO '$USER'@'localhost'; FLUSH PRIVILEGES;")"
    if [ $? -ne 0 ]; then fail "创建失败: $OUT"; fi
    emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"created","database":sys.argv[1],"username":sys.argv[2]}))' "$DB" "$USER")"
    exit 0
    ;;
  drop)
    SQL="DROP DATABASE IF EXISTS \`$DB\`;"
    if [ -n "$USER" ]; then SQL="$SQL DROP USER IF EXISTS '$USER'@'localhost';"; fi
    SQL="$SQL FLUSH PRIVILEGES;"
    OUT="$(run_mysql "$SQL")"
    if [ $? -ne 0 ]; then fail "删除失败: $OUT"; fi
    emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"dropped","database":sys.argv[1]}))' "$DB")"
    exit 0
    ;;
  dump)
    # Logical backup. --single-transaction snapshots InnoDB without locking it,
    # which is what makes this safe to run against a live database.
    OUTDIR="${DUMP_DIR:-/var/backups/neko-console}"
    mkdir -p "$OUTDIR"
    STAMP="$(date +%Y%m%d-%H%M%S)"
    PLAIN="$OUTDIR/mysql-$DB-$STAMP.sql"
    /usr/bin/mysqldump --single-transaction --quick --routines --result-file="$PLAIN" "$DB" 2>/dev/null
    if [ $? -ne 0 ]; then
      rm -f "$PLAIN"
      fail "mysqldump 失败"
    fi
    /bin/gzip -f "$PLAIN"
    if [ $? -ne 0 ]; then fail "压缩失败"; fi
    GZ="$PLAIN.gz"
    SIZE=$(stat -c %s "$GZ")
    SHA=$(sha256sum "$GZ" | cut -d' ' -f1)
    emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"dumped","path":sys.argv[1],"size":int(sys.argv[2]),"sha256":sys.argv[3]}))' "$GZ" "$SIZE" "$SHA")"
    exit 0
    ;;
esac
