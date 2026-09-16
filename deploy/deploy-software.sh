#!/usr/bin/env bash
# =============================================================================
#  deploy-software.sh — build + deploy CODE ONLY (baja, baja-server, baja-apps).
#
#  Updates software; NEVER touches data or config on the server:
#    • server secrets .env                      — excluded
#    • frontend runtime config /eln/assets/env.js — preserved
#    • reference_data / genomic data / userdata  — excluded
#    • config dirs (config/, config.json), sample-data — excluded
#    • geoblock rules/allow/enforce and the built network list — excluded
#  Excluded paths are protected from --delete too, so they are neither
#  overwritten nor removed.
#
#  Usage:  ./deploy-software.sh [--no-build] [--skip-deps]
#                               [--frontend-only|--backend-only] [--dry-run]
#                               [--data <subdir>]...
#
#  --data <subdir>  ALSO push reference_data/<subdir> (additive, no --delete): a bundle
#                   built on this machine that the server cannot build itself -- e.g.
#                   `--data depmap` after py/bio/build-depmap-sl.py. Everything else in
#                   reference_data stays untouched, as always.
#          --no-restart     push without restarting the API (lionscript-only changes;
#                           the node service reads baja-apps from disk). A restart kills
#                           users' running python jobs, so skip it when nothing in dist changed.
#          --force-restart  restart at once instead of waiting for running python jobs.
#  Env:    SERVER=ubuntu@52.87.30.101  SSH_KEY=~/.ssh/baja.pem  ./deploy-software.sh
# =============================================================================
set -euo pipefail

SERVER="${SERVER:-ubuntu@52.87.30.101}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/baja.pem}"
DOMAIN="${DOMAIN:-oligodesigner.com}"
REMOTE_WEB="${REMOTE_WEB:-/eln}"
REMOTE_API="${REMOTE_API:-/opt/baja-server}"
REMOTE_APPS="${REMOTE_APPS:-/opt/baja-apps}"
REMOTE_GEO="${REMOTE_GEO:-/opt/baja-geo}"                 # geo tools + DB-IP databases
REMOTE_GEOBLOCK="${REMOTE_GEOBLOCK:-/etc/nginx/baja-geoblock}"   # nginx block plumbing
RESTART_CMD="${RESTART_CMD:-sudo systemctl restart baja-server && sudo nginx -t && sudo systemctl reload nginx}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRV_DIR="$(cd "$HERE/.." && pwd)"
ROOT_DIR="$(cd "$SRV_DIR/.." && pwd)"
WEB_DIR="$ROOT_DIR/baja"
APPS_DIR="$ROOT_DIR/baja-apps"

die_early(){ echo "$*" >&2; exit 2; }
DO_BUILD=1; DO_DEPS=1; DRY=""; ONLY=""; DATA_DIRS=(); DO_RESTART=1; WAIT_IDLE=1
while [[ $# -gt 0 ]]; do case "$1" in
  --no-build)      DO_BUILD=0 ;;
  --skip-deps)     DO_DEPS=0 ;;
  --frontend-only) ONLY="fe" ;;
  --backend-only)  ONLY="be" ;;
  --no-restart)    DO_RESTART=0 ;;     # lionscript-only push: the node service reads it from disk
  --force-restart) WAIT_IDLE=0 ;;      # restart even while users' python jobs are running
  --dry-run)       DRY="--dry-run" ;;
  --data)          shift; [[ -n "${1:-}" ]] || die_early "--data needs a reference_data subdirectory"; DATA_DIRS+=("$1") ;;
  -h|--help)       sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac; shift; done

c(){ printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SERVER")
RSYNC=(rsync -az --human-readable ${DRY:+$DRY} -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new")
on_remote(){ "${SSH[@]}" "$@"; }
want_fe(){ [[ -z "$ONLY" || "$ONLY" == fe ]]; }
want_be(){ [[ -z "$ONLY" || "$ONLY" == be ]]; }

# Data / config that must NOT be updated (protected from overwrite AND --delete).
DATA_CONFIG_EXCLUDES=(
  --exclude '.git' --exclude 'node_modules' --exclude 'venv'
  --exclude '.env' --exclude '.env.*'
  --exclude 'reference_data' --exclude 'userdata' --exclude 'users_requests'
  --exclude 'config' --exclude 'config.json' --exclude 'sample-data'
  --exclude 'src' --exclude 'deploy' --exclude '.vscode' --exclude '.devcontainer'
  --exclude '*.gff3.gz' --exclude '*.vcf.gz' --exclude '*.tbi'
  --exclude '*.bam' --exclude '*.bai' --exclude '*.2bit' --exclude '*.fa' --exclude '*.fa.gz'
)

# EDITOR SCRATCH AND BUILD CACHES, which are not code and have no business on the server.
#
# A working tree accumulates these between commits -- an editor writing foo.js.bak_before
# beside foo.js, python leaving __pycache__ under every package it imports -- and rsync
# ships whatever it finds. Three such backups reached /opt/baja-apps this way and had to be
# deleted there by hand.
#
# '*.bak_*' and NOT '*.bak': py/ppsets/models/model.joblib.bak is a TRACKED file that is
# meant to be deployed, and the blanket pattern would silently stop updating it. The
# scratch files all carry a suffix after the dot-bak, so the narrower glob catches them
# and leaves real content alone.
#
# Excluded files are also protected from --delete, so anything already on the server stays
# where it is; this stops new junk arriving rather than cleaning up what has.
JUNK_EXCLUDES=(
  --exclude '*.bak_*' --exclude '*.orig' --exclude '*.rej'
  --exclude '__pycache__' --exclude '*.pyc'
)

# ---- preflight --------------------------------------------------------------
c "Preflight — $SERVER (code-only; data & config preserved)"
[[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY"
command -v rsync >/dev/null || die "rsync required locally"
on_remote true 2>/dev/null || die "cannot SSH to $SERVER"
[[ -d "$WEB_DIR" && -d "$SRV_DIR" && -d "$APPS_DIR" ]] || die "expected sibling repos under $ROOT_DIR"
ok "reachable"

# ---- build ------------------------------------------------------------------
if [[ "$DO_BUILD" == 1 ]]; then
  if want_fe; then
    c "Building frontend (Angular, production)…"
    ( cd "$WEB_DIR" && [[ -d node_modules ]] || npm ci --legacy-peer-deps
      cd "$WEB_DIR" && node --max-old-space-size=4096 ./node_modules/@angular/cli/bin/ng \
        build --base-href / --configuration production )
    [[ -d "$WEB_DIR/dist" ]] || die "no baja/dist produced"
    ok "frontend built"
  fi
  if want_be; then
    c "Building API (tsc)…"
    ( cd "$SRV_DIR" && [[ -d node_modules ]] || npm ci
      cd "$SRV_DIR" && npm run build )
    [[ -d "$SRV_DIR/dist" ]] || die "no baja-server/dist produced"
    ok "API built"
  fi
else
  c "Skipping local builds (--no-build)"
fi

# ---- frontend: bundle only, KEEP the server's env.js ------------------------
if want_fe; then
  c "Syncing Angular bundle → $REMOTE_WEB  (env.js preserved)"
  "${RSYNC[@]}" --delete --exclude 'assets/env.js' "$WEB_DIR/dist/" "$SERVER:$REMOTE_WEB/"
  ok "frontend code deployed"
fi

# ---- backend + lionscript: code only ---------------------------------------
if want_be; then
  c "Syncing API code → $REMOTE_API  (.env, data, config preserved)"
  "${RSYNC[@]}" --delete "${DATA_CONFIG_EXCLUDES[@]}" "${JUNK_EXCLUDES[@]}" "$SRV_DIR/" "$SERVER:$REMOTE_API/"

  c "Syncing lionscript code → $REMOTE_APPS  (data & config preserved)"
  # '*.egg-info' is written on the server by the venv's editable installs (sudo pip -e),
  # is root-owned, and must survive: deleting it would break those installs, and rsync
  # cannot delete it anyway (exit 23, which aborts the deploy before the restart).
  "${RSYNC[@]}" --delete --exclude '.git' --exclude 'node_modules' --exclude '*.egg-info' \
    --exclude 'data' --exclude 'config' "${JUNK_EXCLUDES[@]}" "$APPS_DIR/" "$SERVER:$REMOTE_APPS/"

  # Lionscript modules that live under data/ dirs (e.g. baja/data/*.js) are code but get
  # caught by the 'data' exclusion above — sync ONLY the .js files under baja/ so edits to
  # them actually reach the server (additive, tiny).
  c "Syncing lionscript modules under baja/**/data → $REMOTE_APPS"
  "${RSYNC[@]}" -m --include '*/' --include '*.js' --exclude '*' \
    "$APPS_DIR/baja/" "$SERVER:$REMOTE_APPS/baja/"

  # ---- geoblock + traffic tools (deploy/geoblock) ---------------------------
  # Two homes on the server, both owned by ubuntu so no sudo is needed:
  #   /opt/baja-geo             the python/shell tools, beside the DB-IP .mmdb files
  #   /etc/nginx/baja-geoblock  install-geoblock.sh and the geo-block template
  # Additive and by explicit include list. The things NOT sent are the server's own:
  # rules.json (what to block), allow.conf (exemptions), enforce.conf (the on/off
  # switch -- `install-geoblock.sh disable` empties it), networks.conf (built from the
  # databases), and the databases themselves. A --delete here would wipe the databases.
  # A changed 00-baja-geoblock.conf only reaches nginx when install-geoblock.sh install
  # copies it into conf.d again; the restart below reloads nginx but does not do that.
  c "Syncing geo tools → $REMOTE_GEO  (databases preserved)"
  "${RSYNC[@]}" --include 'build-geoblock.py' --include 'refresh-geo.sh' \
    --include 'traffic-report.py' --include 'cities-csv.py' --include 'ip-activity.py' \
    --exclude '*' "$HERE/geoblock/" "$SERVER:$REMOTE_GEO/"
  c "Syncing geoblock plumbing → $REMOTE_GEOBLOCK  (rules, allow, enforce, networks preserved)"
  "${RSYNC[@]}" --include 'install-geoblock.sh' --include '00-baja-geoblock.conf' \
    --exclude '*' "$HERE/geoblock/" "$SERVER:$REMOTE_GEOBLOCK/"
  ok "geoblock tools deployed"

  if [[ "$DO_DEPS" == 1 ]]; then
    c "Installing server deps (npm ci)…"      # full install — app needs the dev/transitive tree
    on_remote "cd '$REMOTE_API' && npm ci"
  else
    c "Skipping server deps (--skip-deps)"
  fi
fi

# ---- reference-data bundles, only the ones asked for --------------------------
# Additive and narrow: one subdirectory of reference_data at a time, never --delete, so
# nothing the server built on its own is touched. This is the code-only script's one
# concession to data, for bundles that are built here and merely copied there.
for sub in "${DATA_DIRS[@]}"; do
  src="$SRV_DIR/reference_data/$sub"
  [[ -d "$src" ]] || die "no reference_data/$sub on this machine"
  c "Syncing reference_data/$sub → $REMOTE_API/reference_data/$sub  (additive)"
  [[ -n "$DRY" ]] || on_remote "mkdir -p '$REMOTE_API/reference_data/$sub'"
  "${RSYNC[@]}" --exclude 'raw' --exclude '*.part' --exclude 'build.log' "$src/" "$SERVER:$REMOTE_API/reference_data/$sub/"
  ok "reference_data/$sub synced"
done

# ---- restart + smoke --------------------------------------------------------
if [[ -z "$DRY" && "$DO_RESTART" == 0 ]]; then
  # Lionscript (baja-apps) is read from disk on every /get-script (cache TTL is 0 unless
  # cache-ttl.txt says otherwise), so a push of scripts alone needs no restart -- and a
  # restart is not free: it kills every python job users have running at that moment.
  ok "Not restarting (--no-restart): scripts are live, the API keeps its current build"
elif [[ -z "$DRY" ]]; then
  # A RESTART KILLS RUNNING PYTHON JOBS. The node service spawns them as children and
  # systemd stops the whole group, so a user mid-build (a Claude budget, an off-target
  # search) loses the run. Wait for the box to go quiet first; --force-restart skips it.
  if [[ "$WAIT_IDLE" == 1 ]]; then
    c "Waiting for running python jobs to finish before restarting…"
    __idle=0
    for __w in $(seq 1 90); do              # up to 15 minutes, the server's own job cap
      __jobs="$(curl -fsS --max-time 8 "https://$DOMAIN/py-jobs" 2>/dev/null || echo '')"
      if [[ -z "$__jobs" ]]; then
        warn "could not read https://$DOMAIN/py-jobs; restarting without waiting"; __idle=1; break
      fi
      __busy="$(printf '%s' "$__jobs" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); j=d.get("jobs") or []
    print(len(j)+int(d.get("queued") or 0)); print("\n".join(("  %s  %s  %ds" % (x.get("script"), x.get("user") or "-", int((x.get("ageMs") or 0)/1000))) for x in j))
except Exception: print(0)' 2>/dev/null)"
      if [[ "${__busy%%$'\n'*}" == 0 ]]; then __idle=1; break; fi
      [[ "$__w" == 1 || $((__w % 6)) == 0 ]] && printf '  still running:\n%s\n' "${__busy#*$'\n'}"
      sleep 10
    done
    [[ "$__idle" == 1 ]] || warn "python jobs still running after 15 minutes; restarting anyway (they are told to run again)"
  fi
  c "Restarting services…"
  on_remote "$RESTART_CMD"
  ok "restarted"
  # WAIT FOR THE API, do not race it.
  #
  # systemctl returns as soon as the unit is started, not when node is accepting
  # connections, so probing immediately gets nginx's own 502 in about 200ms. curl
  # -f then fails instantly -- --max-time never comes into it, because a 502 is a
  # reply, not a timeout -- and every deploy ended on a warning about a service
  # that was in fact fine a second later.
  #
  # Retry until it answers. 502/503 and a refused connection all mean "not up yet";
  # anything else is the answer, good or bad.
  c "Waiting for the API to answer…"
  __pi_ok=0
  for __i in $(seq 1 30); do
    if curl -fsS --max-time 5 "https://$DOMAIN/stripe/price-info" >/tmp/_pi 2>/dev/null; then
      __pi_ok=1; break
    fi
    sleep 2
  done
  if [[ "$__pi_ok" == 1 ]]; then
    ok "https://$DOMAIN/stripe/price-info → $(cat /tmp/_pi)"; rm -f /tmp/_pi
  else
    # Say what it actually returned, so a real outage is distinguishable from a
    # slow start without going to the journal first.
    __code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/stripe/price-info" 2>/dev/null || echo 000)"
    warn "price-info still not answering after 60s (last HTTP $__code) — check: ${SSH[*]} 'journalctl -u baja-server -n 40'"
    rm -f /tmp/_pi
  fi
else
  c "Dry run complete — nothing changed."
fi

ok "Software deploy finished → https://$DOMAIN  (data & config untouched)"
