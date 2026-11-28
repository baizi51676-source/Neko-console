#!/bin/bash
# Neko-console privileged helper for nginx — setuid root entry point.
#
# WHY SETUID, AND WHY IT IS SAFE HERE
#
# The console runs inside a systemd sandbox with `NoNewPrivileges=true`. That
# setting deliberately makes sudo (a setuid binary) unable to escalate, and the
# console should NOT be given that up — it is what keeps a compromised console
# from owning the host.
#
# A setuid helper is the standard way to expose one narrow privileged operation
# to an unprivileged caller (ping, passwd, mount all work this way). Safety comes
# from the helper doing *nothing* with caller-supplied input:
#
#   - the action is read from a fixed request file, not argv
#   - the action is whitelisted against three literal words
#   - no path, unit name, or command from the caller is ever used
#   - NO arguments are accepted at all; any argument is rejected
#
# Compare with the alternative (patching the unit to drop NoNewPrivileges and
# granting passwordless sudo for nginx): that would give the console's Node
# process a general root path, which is strictly worse than one audited binary
# that cannot be told to do anything else.
#
# Install: root:root, mode 4750, group neko.

set -uo pipefail

# --- refuse any argument -------------------------------------------------
# A caller that passes flags is either confused or probing; exit rather than
# trying to interpret them.
if [ "$#" -ne 0 ]; then
  echo "此程序不接受参数" >&2
  exit 2
fi

REQ_DIR="/var/lib/neko-console/helper"
REQ_FILE="$REQ_DIR/nginx-request"
OUT_FILE="$REQ_DIR/nginx-result.json"

# The request file holds "action\ntimestamp": the timestamp exists only to make
# a repeated identical action register as a file modification so systemd re-fires
# the path unit. Only the first line matters here.
ACTION="$(head -n1 "$REQ_FILE" 2>/dev/null | tr -d '[:space:]')"
ACTION="${ACTION:-status}"

emit() {
  local ok="$1"
  local payload="$2"
  # Written as root but readable by the console; the console only reads it.
  python3 - "$ok" "$payload" "$OUT_FILE" <<'PY'
import json, sys, datetime
ok, payload, path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'w') as fh:
    json.dump({
        "ok": ok == "true",
        "at": datetime.datetime.now().isoformat(),
        "output": payload[-4000:],
    }, fh)
PY
  chmod 644 "$OUT_FILE"
}

case "$ACTION" in
  test)
    OUT="$(/usr/sbin/nginx -t 2>&1)"
    CODE=$?
    if [ $CODE -eq 0 ]; then emit true "$OUT"; else emit false "$OUT"; fi
    exit $CODE
    ;;
  reload)
    OUT="$(/usr/sbin/nginx -t 2>&1)"
    CODE=$?
    if [ $CODE -ne 0 ]; then
      emit false "$OUT"
      exit $CODE
    fi
    RELOAD="$(/bin/systemctl reload nginx 2>&1)"
    RCODE=$?
    emit $([ $RCODE -eq 0 ] && echo true || echo false) "$OUT
$RELOAD"
    exit $RCODE
    ;;
  status)
    OUT="$(/usr/sbin/nginx -v 2>&1) $(/bin/systemctl is-active nginx 2>&1)"
    emit true "$OUT"
    exit 0
    ;;
  *)
    emit false "未知操作: $ACTION"
    echo "未知操作: $ACTION" >&2
    exit 2
    ;;
esac
