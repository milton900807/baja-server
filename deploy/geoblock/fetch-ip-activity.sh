#!/bin/bash
# Download per-IP activity (with the city each address comes from) from the
# production host to this machine.
#
# Copies ip-activity.py to the server, runs it there under sudo (the nginx logs
# are root-readable, and the DB-IP databases only exist on the server), then
# pulls the resulting CSV down. Nothing about the addresses leaves the server
# except the report you asked for.
#
#   ./fetch-ip-activity.sh                     everything on disk (~14 days) -> ./ip-activity-<date>.csv
#   ./fetch-ip-activity.sh --days 7            last week
#   ./fetch-ip-activity.sh --city Jakarta      one city
#   ./fetch-ip-activity.sh --json              JSON instead of CSV
#   OUT=report.csv ./fetch-ip-activity.sh      choose the local file name
#
# Every argument is passed straight through to ip-activity.py (see its --help).
#
# Env:  SERVER=ubuntu@52.87.30.101  SSH_KEY=~/.ssh/baja.pem  OUT=<local file>
set -euo pipefail

SERVER="${SERVER:-ubuntu@52.87.30.101}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/baja.pem}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/ip-activity.py"
REMOTE_PY=/opt/venv/bin/python3
REMOTE_SCRIPT=/tmp/ip-activity.py

ext=csv
for a in "$@"; do [ "$a" = "--json" ] && ext=json; done
OUT="${OUT:-$HERE/ip-activity-$(date +%Y-%m-%d).$ext}"
REMOTE_OUT="/tmp/ip-activity-$$.$ext"

[ -f "$SSH_KEY" ] || { echo "no ssh key at $SSH_KEY" >&2; exit 1; }
[ -f "$SCRIPT" ]  || { echo "no $SCRIPT" >&2; exit 1; }

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SERVER")
SCP=(scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

echo "  uploading ip-activity.py"
"${SCP[@]}" "$SCRIPT" "$SERVER:$REMOTE_SCRIPT"

echo "  running on $SERVER"
"${SSH[@]}" "sudo $REMOTE_PY $REMOTE_SCRIPT --out $REMOTE_OUT $(printf '%q ' "$@") \
             && sudo chown \$(id -u) $REMOTE_OUT"

echo "  downloading"
"${SCP[@]}" "$SERVER:$REMOTE_OUT" "$OUT"
"${SSH[@]}" "rm -f $REMOTE_OUT $REMOTE_SCRIPT"

rows=$(( $(wc -l < "$OUT") - 1 ))
[ "$ext" = json ] && rows="json"
echo "  -> $OUT  ($rows rows)"
