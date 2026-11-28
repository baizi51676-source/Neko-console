#!/bin/bash
# Neko-console privileged helper for certificates.
#
# certbot must run as root: it writes /etc/letsencrypt, and the webroot challenge
# is served from a root-owned directory. The console is unprivileged, so — like
# the nginx and database helpers — it writes a request file and this root-owned
# script acts on it.
#
# SECURITY
#
#   - the request is JSON, parsed by python3 (never eval'd)
#   - every domain is re-validated against a strict hostname regex HERE, not
#     trusted from the console
#   - certbot is invoked with a fixed argv array; no string interpolation into a
#     shell command
#   - only three operations exist: issue, renew, list
#
# The domain list is the only user-controlled data that reaches an external
# process, and it cannot contain a flag because each value must match the
# hostname regex (`-d --foo` is rejected).

set -uo pipefail

REQ_DIR="/var/lib/neko-console/helper"
REQ_FILE="$REQ_DIR/cert-request.json"
OUT_FILE="$REQ_DIR/cert-result.json"
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

fail() {
  emit false "$(python3 -c 'import json,sys;print(json.dumps({"message":sys.argv[1]}))' "$1")"
  exit 1
}

[ -f "$REQ_FILE" ] || fail "缺少请求文件"

# Validate and extract with python3; emit shell-safe assignments.
PARSED="$(python3 - "$REQ_FILE" <<'PY'
import json, sys, re, shlex
try:
    with open(sys.argv[1]) as fh:
        req = json.load(fh)
except Exception:
    print("PARSE_ERROR"); sys.exit(0)

op = str(req.get("op", ""))
hostname = re.compile(r'^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$', re.I)

if op not in ("issue", "renew", "list"):
    print("BAD_OP"); sys.exit(0)

domains = req.get("domains") or []
if not isinstance(domains, list):
    print("BAD_DOMAINS"); sys.exit(0)
for d in domains:
    if not hostname.match(str(d)):
        print("BAD_DOMAIN"); sys.exit(0)
if op == "issue" and not domains:
    print("NO_DOMAINS"); sys.exit(0)

lineage = str(req.get("lineage", "") or "")
if op == "renew" and not re.match(r'^[A-Za-z0-9._-]{1,200}$', lineage):
    print("BAD_LINEAGE"); sys.exit(0)

print(f"OP={shlex.quote(op)}")
print(f"LINEAGE={shlex.quote(lineage)}")
# Each domain is already regex-validated, so this join cannot introduce a flag.
print(f"DOMAINS={shlex.quote(' '.join(str(d) for d in domains))}")
PY
)"

case "$PARSED" in
  PARSE_ERROR) fail "请求 JSON 无法解析" ;;
  BAD_OP) fail "未知操作" ;;
  BAD_DOMAINS) fail "domains 必须是数组" ;;
  BAD_DOMAIN) fail "域名格式不合法" ;;
  NO_DOMAINS) fail "请提供至少一个域名" ;;
  BAD_LINEAGE) fail "证书名不合法" ;;
esac

eval "$PARSED"

ACME_ROOT="/var/www/neko-acme"
mkdir -p "$ACME_ROOT/.well-known/acme-challenge"

case "$OP" in
  issue)
    ARGS=(certonly --webroot --webroot-path "$ACME_ROOT"
          --non-interactive --agree-tos --register-unsafely-without-email
          --keep-until-expiring --expand)
    for d in $DOMAINS; do
      ARGS+=(-d "$d")
    done
    OUT="$(/usr/bin/certbot "${ARGS[@]}" 2>&1)"
    CODE=$?
    if [ $CODE -ne 0 ]; then fail "证书申请失败: $(printf '%s' "$OUT" | tail -c 600)"; fi
    # Report which lineage was written.
    FIRST="${DOMAINS%% *}"
    emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"issued","lineage":sys.argv[1]}))' "$FIRST")"
    exit 0
    ;;
  renew)
    OUT="$(/usr/bin/certbot renew --cert-name "$LINEAGE" --non-interactive 2>&1)"
    CODE=$?
    if [ $CODE -ne 0 ]; then fail "续期失败: $(printf '%s' "$OUT" | tail -c 600)"; fi
    emit true "$(python3 -c 'import json,sys;print(json.dumps({"message":"renewed","lineage":sys.argv[1]}))' "$LINEAGE")"
    exit 0
    ;;
  list)
    OUT="$(ls -1 /etc/letsencrypt/live 2>/dev/null || true)"
    emit true "$(python3 -c '
import json,sys
items=[l for l in sys.argv[1].split(chr(10)) if l]
print(json.dumps({"message":"ok","lineages":items}))' "$OUT")"
    exit 0
    ;;
esac
