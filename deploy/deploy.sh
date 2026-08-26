#!/usr/bin/env bash
# =============================================================================
#  deploy.sh — build the BajaBio stack LOCALLY and push artifacts to the server.
#
#  Model: host + systemd + nginx (offloads the heavy Angular/tsc build from the
#  small EC2 box). Builds on your machine, rsyncs artifacts over SSH, installs
#  runtime deps on the server, restarts the API and reloads nginx.
#
#  By DEFAULT it also syncs data resources (./reference_data, baja-apps/data).
#  Use --no-data to skip them (fast code-only redeploys).
#
#  Expected sibling layout (this script lives in baja-server/deploy/):
#     parent/ ├ baja/  ├ baja-server/  └ baja-apps/
#
#  Usage:
#     ./deploy.sh [options]
#       --no-data        skip reference_data / data resources (code only)
#       --no-build       skip local builds, deploy whatever is already built
#       --skip-deps      don't run `npm ci` on the server (deps unchanged)
#       --frontend-only  build+push only the Angular bundle
#       --backend-only   build+push only the API (+lionscript)
#       --minify-apps    minify + obfuscate the lionscript before pushing
#                        (~50% smaller source, fail-safe per file). Off by default.
#       --dry-run        show what rsync would transfer, change nothing
#       -h, --help
#
#  Override connection/paths via env (or edit the defaults below):
#     SERVER=ubuntu@52.87.30.101  SSH_KEY=~/.ssh/baja.pem  ./deploy.sh
# =============================================================================
set -euo pipefail

# ---- config (override via environment) --------------------------------------
SERVER="${SERVER:-ubuntu@52.87.30.101}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/baja.pem}"
DOMAIN="${DOMAIN:-oligodesigner.com}"

REMOTE_WEB="${REMOTE_WEB:-/eln}"                     # nginx docroot (Angular dist)
REMOTE_API="${REMOTE_API:-/opt/baja-server}"         # Node app root
REMOTE_APPS="${REMOTE_APPS:-/opt/baja-apps}"         # lionscript library
REMOTE_DATA="${REMOTE_DATA:-$REMOTE_API/reference_data}"  # relative-to-cwd data root
# How the server restarts the API + reloads nginx (override for a different setup):
RESTART_CMD="${RESTART_CMD:-sudo systemctl restart baja-server && sudo nginx -t && sudo systemctl reload nginx}"

# ---- resolve local repo roots relative to this script -----------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRV_DIR="$(cd "$HERE/.." && pwd)"          # baja-server
ROOT_DIR="$(cd "$SRV_DIR/.." && pwd)"      # parent holding the siblings
WEB_DIR="$ROOT_DIR/baja"
APPS_DIR="$ROOT_DIR/baja-apps"
ENV_PROD="$HERE/env-prod.js"               # production frontend config

# ---- flags ------------------------------------------------------------------
DO_DATA=1; DO_BUILD=1; DO_DEPS=1; DRY=""; ONLY=""; MINIFY=0
while [[ $# -gt 0 ]]; do case "$1" in
  --no-data)       DO_DATA=0 ;;
  --no-build)      DO_BUILD=0 ;;
  --skip-deps)     DO_DEPS=0 ;;
  --frontend-only) ONLY="fe" ;;
  --backend-only)  ONLY="be" ;;
  --minify-apps)   MINIFY=1 ;;
  --dry-run)       DRY="--dry-run" ;;
  -h|--help)       sed -n '2,40p' "$0"; exit 0 ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac; shift; done

# ---- helpers ----------------------------------------------------------------
c(){ printf '\033[1;36m▶ %s\033[0m\n' "$*"; }        # step
ok(){ printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SERVER")
RSYNC=(rsync -az --human-readable ${DRY:+$DRY} -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new")
on_remote(){ "${SSH[@]}" "$@"; }

want_fe(){ [[ -z "$ONLY" || "$ONLY" == fe ]]; }
want_be(){ [[ -z "$ONLY" || "$ONLY" == be ]]; }

# ---- preflight --------------------------------------------------------------
c "Preflight — $SERVER  (domain: $DOMAIN)"
[[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY  (set SSH_KEY=…)"
command -v rsync >/dev/null || die "rsync is required on this machine"
on_remote true 2>/dev/null || die "cannot SSH to $SERVER (check key / security group / IP)"
[[ -d "$WEB_DIR" && -d "$SRV_DIR" && -d "$APPS_DIR" ]] || die "expected sibling repos baja/ baja-server/ baja-apps/ under $ROOT_DIR"
ok "reachable"

# ---- 1. local builds --------------------------------------------------------
if [[ "$DO_BUILD" == 1 ]]; then
  if want_fe; then
    c "Building frontend (Angular, production)…"
    ( cd "$WEB_DIR" && [[ -d node_modules ]] || npm ci --legacy-peer-deps
      cd "$WEB_DIR" && node --max-old-space-size=4096 ./node_modules/@angular/cli/bin/ng \
        build --base-href / --configuration production )
    [[ -d "$WEB_DIR/dist" ]] || die "Angular build produced no dist/"
    ok "frontend built → baja/dist"
  fi
  if want_be; then
    c "Building API (tsc)…"
    ( cd "$SRV_DIR" && [[ -d node_modules ]] || npm ci
      cd "$SRV_DIR" && npm run build )
    [[ -d "$SRV_DIR/dist" ]] || die "API build produced no dist/"
    ok "API built → baja-server/dist"
  fi
else
  c "Skipping local builds (--no-build)"
fi

# ---- 2. ensure remote dirs exist --------------------------------------------
c "Preparing remote directories…"
on_remote "sudo mkdir -p '$REMOTE_WEB' '$REMOTE_API' '$REMOTE_APPS' '$REMOTE_DATA' && sudo chown -R \$(whoami) '$REMOTE_WEB' '$REMOTE_API' '$REMOTE_APPS'"

# ---- 3. sync frontend -------------------------------------------------------
if want_fe; then
  c "Syncing Angular bundle → $REMOTE_WEB"
  # --delete cleans old hashed assets, but keep the production env.js we set below.
  "${RSYNC[@]}" --delete --exclude 'assets/env.js' "$WEB_DIR/dist/" "$SERVER:$REMOTE_WEB/"
  if [[ -f "$ENV_PROD" ]]; then
    "${RSYNC[@]}" "$ENV_PROD" "$SERVER:$REMOTE_WEB/assets/env.js"
    ok "frontend + production env.js deployed"
  else
    printf '\033[1;33m! %s\033[0m\n' "no deploy/env-prod.js — leaving existing $REMOTE_WEB/assets/env.js untouched"
  fi
fi

# ---- 4. sync API + lionscript ----------------------------------------------
if want_be; then
  c "Syncing API → $REMOTE_API"
  # Whole tree (dist, py-scripts, tools, config, data files, manifests) minus deps,
  # secrets, local-only and server-managed state. Excluded paths are protected from
  # --delete, so server node_modules / reference_data / userdata survive.
  "${RSYNC[@]}" --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'venv' \
    --exclude '.env' --exclude 'reference_data' --exclude 'userdata' \
    --exclude 'src' --exclude 'deploy' --exclude '.vscode' --exclude '.devcontainer' \
    "$SRV_DIR/" "$SERVER:$REMOTE_API/"

  # Optionally minify + obfuscate the lionscript for a faster-downloading production
  # bundle (~50% smaller source; ~80%+ after nginx gzip). Fail-safe: any file that
  # can't be safely minified ships verbatim. Off by default — pass --minify-apps.
  APPS_SRC="$APPS_DIR"; APPS_EXTRA_EXCL=()
  if [[ "$MINIFY" == 1 ]]; then
    c "Minifying + obfuscating lionscript…"
    ( cd "$HERE" && [[ -d node_modules/terser ]] || npm i terser --no-save --silent )
    APPS_STAGE="$(mktemp -d)/baja-apps"
    node "$HERE/minify-apps.js" "$APPS_DIR" "$APPS_STAGE" || die "minify-apps failed"
    APPS_SRC="$APPS_STAGE"
    # staging has no data/ — protect the server's copy from --delete (data step syncs it).
    APPS_EXTRA_EXCL=(--exclude 'data')
  fi

  c "Syncing lionscript library → $REMOTE_APPS"
  "${RSYNC[@]}" --delete --exclude '.git' --exclude 'node_modules' "${APPS_EXTRA_EXCL[@]}" \
    "$APPS_SRC/" "$SERVER:$REMOTE_APPS/"

  # Some lionscript modules live under data/ dirs (e.g. baja/data/*.js, baja/plate/data,
  # baja/manchester/menu/data) and get caught by the 'data' exclusion above. Ship them by
  # syncing ONLY the .js files under baja/ from the real source (additive, un-minified,
  # tiny). Without this, edits to those modules never reach the server.
  c "Syncing lionscript modules under baja/**/data → $REMOTE_APPS"
  "${RSYNC[@]}" -m --include '*/' --include '*.js' --exclude '*' \
    "$APPS_DIR/baja/" "$SERVER:$REMOTE_APPS/baja/"

  if [[ "$DO_DEPS" == 1 ]]; then
    # Full install (NOT --omit=dev): the app require()s packages (e.g. chalk) that are
    # only present via the dev/transitive tree, so prod-only installs crash at boot.
    c "Installing server deps (npm ci)…"
    on_remote "cd '$REMOTE_API' && npm ci"
  else
    c "Skipping server dep install (--skip-deps)"
  fi
fi

# ---- 5. data resources (default ON) ----------------------------------------
if [[ "$DO_DATA" == 1 ]]; then
  c "Syncing data resources (reference_data, baja-apps/data)…"
  if [[ -d "$SRV_DIR/reference_data" ]]; then
    # additive (no --delete): don't wipe indexes the server built on its own.
    "${RSYNC[@]}" "$SRV_DIR/reference_data/" "$SERVER:$REMOTE_DATA/"
    ok "reference_data synced"
  else
    printf '\033[1;33m! %s\033[0m\n' "no baja-server/reference_data — skipping"
  fi
  # baja-apps/data already covered by the lionscript sync above (want_be), but
  # sync it explicitly for --frontend-only/--no-build data pushes:
  [[ -d "$APPS_DIR/data" ]] && "${RSYNC[@]}" "$APPS_DIR/data/" "$SERVER:$REMOTE_APPS/data/"
else
  c "Skipping data resources (--no-data)"
fi

# ---- 6. ensure nginx gzip (idempotent) --------------------------------------
# Compress proxied JSON/JS responses (the lionscript modules go out as JSON via
# /get-script) — ~80% smaller over the wire. Idempotent: enables the directives
# only if they are still commented out in the stock nginx.conf.
if [[ -z "$DRY" ]]; then
  c "Ensuring nginx gzip for JSON/JS…"
  on_remote 'if grep -q "^\s*# gzip_types" /etc/nginx/nginx.conf; then
      sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.$(date +%s)
      sudo sed -i \
        -e "s/^\(\s*\)# gzip_vary on;/\1gzip_vary on;/" \
        -e "s/^\(\s*\)# gzip_proxied any;/\1gzip_proxied any;/" \
        -e "s/^\(\s*\)# gzip_comp_level 6;/\1gzip_comp_level 6;/" \
        -e "s/^\(\s*\)# gzip_http_version 1.1;/\1gzip_http_version 1.1;/" \
        -e "s|^\(\s*\)# gzip_types .*|\1gzip_types text/plain text/css application/json application/javascript text/javascript application/xml application/xml+rss image/svg+xml;\n\1gzip_min_length 512;|" \
        /etc/nginx/nginx.conf
      sudo nginx -t && echo "gzip enabled"
    else echo "gzip already enabled"; fi'
fi

# ---- 7. restart + smoke test ------------------------------------------------
if [[ -z "$DRY" ]]; then
  c "Restarting services on the server…"
  on_remote "$RESTART_CMD"
  ok "restarted"

  c "Smoke test…"
  if curl -fsS --max-time 15 "https://$DOMAIN/stripe/price-info" >/tmp/_pi 2>/dev/null; then
    ok "https://$DOMAIN/stripe/price-info → $(cat /tmp/_pi)"; rm -f /tmp/_pi
  else
    printf '\033[1;33m! %s\033[0m\n' "price-info not reachable yet — check: ${SSH[*]} 'journalctl -u baja-server -n 50'"
  fi
else
  c "Dry run complete — no changes made, services not restarted."
fi

ok "Deploy finished → https://$DOMAIN"
