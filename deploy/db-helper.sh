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
engine = str(req.get("engine", "mysql"))
ident = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')

def q(v):
    # shlex.quote gives us a safe single-quoted shell token.
    return shlex.quote(str(v))

db = str(req.get("database", ""))
user = str(req.get("username", "") or "")
pw = str(req.get("password", "") or "")

if engine not in ("mysql", "postgres"):
    print("BAD_ENGINE")
    sys.exit(0)
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
print(f"ENGINE={q(engine)}")
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

# ---------------------------------------------------------------------------
# PostgreSQL
#
# Runs as the `postgres` OS user: PostgreSQL's local socket uses peer
# authentication, so only that account can reach the cluster as superuser.
# This helper already runs as root, so `su` here is a plain user switch, not an
# escalation — the console cannot influence which user it becomes.
# ---------------------------------------------------------------------------
run_pg() {
  local sql="$1"
  # `cd /` first: su(1) starts in /root, which postgres cannot read, and the
  # resulting warning would otherwise be parsed as command output.
  su -s /bin/bash postgres -c "cd / && psql -v ON_ERROR_STOP=1 -tAc $(printf '%q' "$sql")" 2>&1
}

if [ "$ENGINE" = "postgres" ]; then
  case "$OP" in
    ping)
      OUT="$(su -s /bin/bash postgres -c 'cd / && psql -tAc "SELECT version()"' 2>&1)"
      if [ $? -eq 0 ]; then
        emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"ok","version":sys.argv[1].split(",")[0]}))' "$OUT")"
        exit 0
      fi
      fail "PostgreSQL 连接失败: $OUT"
      ;;
    list)
      OUT="$(run_pg "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres'")"
      if [ $? -ne 0 ]; then fail "查询失败: $OUT"; fi
      emit true "$(python3 -c 'import json,sys;print(json.dumps({"databases":[l for l in sys.argv[1].split(chr(10)) if l]}))' "$OUT")"
      exit 0
      ;;
    create)
      # Role first (idempotent), then the database owned by it. CREATE DATABASE
      # cannot run inside a transaction block, so they are separate invocations.
      ROLE_EXISTS="$(run_pg "SELECT 1 FROM pg_roles WHERE rolname = '$USER'")"
      if [ "$(printf '%s' "$ROLE_EXISTS" | tr -d '[:space:]')" = "1" ]; then
        OUT="$(run_pg "ALTER ROLE \"$USER\" WITH LOGIN PASSWORD '$PW'")"
      else
        OUT="$(run_pg "CREATE ROLE \"$USER\" LOGIN PASSWORD '$PW'")"
      fi
      if [ $? -ne 0 ]; then fail "创建角色失败: $OUT"; fi
      OUT="$(run_pg "CREATE DATABASE \"$DB\" OWNER \"$USER\"")"
      if [ $? -ne 0 ]; then fail "创建数据库失败: $OUT"; fi

      # PostgreSQL grants CONNECT on every database to PUBLIC, and `REVOKE ...
      # FROM <role>` does nothing about a privilege the role holds *via PUBLIC*.
      # That was the bug: the isolation check kept failing because the role's
      # access came from PUBLIC, not from a direct grant.
      #
      # The fix is to remove PUBLIC's CONNECT on the databases this role must
      # never enter, then re-grant CONNECT to the roles that legitimately need
      # them. We only touch `postgres` and `template1`, and we restore access for
      # every non-`pg_` role so existing operators are not locked out.
      for protected_db in postgres template1; do
        ISO="$(run_pg "REVOKE CONNECT ON DATABASE \"$protected_db\" FROM PUBLIC")"
        if [ $? -ne 0 ]; then fail "收紧 $protected_db 权限失败: $ISO"; fi
        # Give the cluster's own accounts back what PUBLIC used to provide.
        RESTORE="$(run_pg "
          SELECT string_agg(format('GRANT CONNECT ON DATABASE \"$protected_db\" TO %I', rolname), '; ')
          FROM pg_roles
          WHERE rolname NOT LIKE 'pg\\_%'
            AND rolname <> '$USER'")"
        if [ -n "$(printf '%s' "$RESTORE" | tr -d '[:space:]')" ] && [ "$RESTORE" != "" ]; then
          run_pg "$RESTORE" >/dev/null 2>&1 || true
        fi
      done

      ISO="$(run_pg "GRANT CONNECT ON DATABASE \"$DB\" TO \"$USER\"")"
      if [ $? -ne 0 ]; then fail "授予数据库权限失败: $ISO"; fi

      # PostgreSQL 14 requires schema ownership (or a grant) to create tables in
      # `public`; PG 15+ removed the PUBLIC default. Taking ownership makes the
      # new role able to work immediately on either version.
      su -s /bin/bash postgres -c "cd / && psql -q -v ON_ERROR_STOP=1 -d $(printf '%q' "$DB") -c 'ALTER SCHEMA public OWNER TO \"$USER\"'" >/dev/null 2>&1 || true

      # Verify the isolation actually took effect rather than trusting the SQL.
      #
      # `has_database_privilege` returns boolean, rendered by psql as `t`/`f` —
      # but `::text` on a boolean yields the words `true`/`false`. Comparing
      # against `f` therefore always failed and blocked creation with a
      # misleading message. Accept both spellings.
      CHECK="$(run_pg "SELECT has_database_privilege('$USER','postgres','CONNECT')::text")"
      CHECK_TRIMMED="$(printf '%s' "$CHECK" | tr -d '[:space:]')"
      if [ "$CHECK_TRIMMED" != "f" ] && [ "$CHECK_TRIMMED" != "false" ]; then
        fail "无法收紧 PostgreSQL 默认权限：新角色仍可连接其他数据库（实际: $CHECK_TRIMMED）"
      fi

      emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"created","database":sys.argv[1],"username":sys.argv[2]}))' "$DB" "$USER")"
      exit 0
      ;;
    drop)
      OUT="$(run_pg "DROP DATABASE IF EXISTS \"$DB\"")"
      if [ $? -ne 0 ]; then fail "删除数据库失败: $OUT"; fi
      if [ -n "$USER" ]; then
        # A role that still owns objects elsewhere cannot be dropped; report that
        # rather than hiding it, because the operator must reassign ownership.
        ROUT="$(run_pg "DROP ROLE IF EXISTS \"$USER\"")"
        if [ $? -ne 0 ]; then
          emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"dropped","database":sys.argv[1],"roleDropped":False,"note":"角色仍拥有其他对象，未删除"}))' "$DB")"
          exit 0
        fi
      fi
      emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"dropped","database":sys.argv[1],"roleDropped":True}))' "$DB")"
      exit 0
      ;;
    dump)
      OUTDIR="${DUMP_DIR:-/var/backups/neko-console}"
      mkdir -p "$OUTDIR"
      STAMP="$(date +%Y%m%d-%H%M%S)"
      PLAIN="$OUTDIR/postgres-$DB-$STAMP.sql"
      chown postgres:postgres "$OUTDIR" 2>/dev/null || true
      # `cd /` because `su - postgres` starts in /root, which it cannot read and
      # warns about on every invocation.
      su -s /bin/bash postgres -c "cd / && pg_dump --no-owner --clean --if-exists -f $(printf '%q' "$PLAIN") $(printf '%q' "$DB")" 2>&1
      if [ ! -s "$PLAIN" ]; then
        rm -f "$PLAIN"
        fail "pg_dump 失败"
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
fi

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
