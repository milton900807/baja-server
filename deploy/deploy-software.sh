#!/usr/bin/env bash
# =============================================================================
#  deploy-software.sh — build + deploy CODE ONLY (baja, baja-server, baja-apps).
#
#  Updates software; NEVER touches data or config on the server:
#    • server secrets .env                      — excluded
#    • frontend runtime config /eln/assets/env.js — preserved
#    • reference_data / genomic data / userdata  — excluded
#    • config dirs (config/, config.json), sample-data — excluded
#  Excluded paths are protected from --delete too, so they are neither
#  overwritten nor removed.
#
#  Usage:  ./deploy-software.sh [--no-build] [--skip-deps]
#                               [--frontend-only|--backend-only] [--dry-run]
#  Env:    SERVER=ubuntu@52.87.30.101  SSH_KEY=~/.ssh/baja.pem  ./deploy-software.sh
# =============================================================================
set -euo pipefail

SERVER="${SERVER:-ubuntu@52.87.30.101}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/baja.pem}"
DOMAIN="${DOMAIN:-oligodesigner.com}"
REMOTE_WEB="${REMOTE_WEB:-/eln}"
REMOTE_API="${REMOTE_API:-/opt/baja-server}"
REMOTE_APPS="${REMOTE_APPS:-/opt/baja-apps}"
RESTART_CMD="${RESTART_CMD:-sudo systemctl restart baja-server && sudo nginx -t && sudo systemctl reload nginx}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRV_DIR="$(cd "$HERE/.." && pwd)"
ROOT_DIR="$(cd "$SRV_DIR/.." && pwd)"
WEB_DIR="$ROOT_DIR/baja"
APPS_DIR="$ROOT_DIR/baja-apps"

DO_BUILD=1; DO_DEPS=1; DRY=""; ONLY=""
while [[ $# -gt 0 ]]; do case "$1" in
  --no-build)      DO_BUILD=0 ;;
  --skip-deps)     DO_DEPS=0 ;;
  --frontend-only) ONLY="fe" ;;
  --backend-only)  ONLY="be" ;;
  --dry-run)       DRY="--dry-run" ;;
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
  "${RSYNC[@]}" --delete "${DATA_CONFIG_EXCLUDES[@]}" "$SRV_DIR/" "$SERVER:$REMOTE_API/"

  c "Syncing lionscript code → $REMOTE_APPS  (data & config preserved)"
  "${RSYNC[@]}" --delete --exclude '.git' --exclude 'node_modules' \
    --exclude 'data' --exclude 'config' "$APPS_DIR/" "$SERVER:$REMOTE_APPS/"

  # Lionscript modules that live under data/ dirs (e.g. baja/data/*.js) are code but get
  # caught by the 'data' exclusion above — sync ONLY the .js files under baja/ so edits to
  # them actually reach the server (additive, tiny).
  c "Syncing lionscript modules under baja/**/data → $REMOTE_APPS"
  "${RSYNC[@]}" -m --include '*/' --include '*.js' --exclude '*' \
    "$APPS_DIR/baja/" "$SERVER:$REMOTE_APPS/baja/"

  if [[ "$DO_DEPS" == 1 ]]; then
    c "Installing server deps (npm ci)…"      # full install — app needs the dev/transitive tree
    on_remote "cd '$REMOTE_API' && npm ci"
  else
    c "Skipping server deps (--skip-deps)"
  fi
fi

# ---- restart + smoke --------------------------------------------------------
if [[ -z "$DRY" ]]; then
  c "Restarting services…"
  on_remote "$RESTART_CMD"
  ok "restarted"
  if curl -fsS --max-time 15 "https://$DOMAIN/stripe/price-info" >/tmp/_pi 2>/dev/null; then
    ok "https://$DOMAIN/stripe/price-info → $(cat /tmp/_pi)"; rm -f /tmp/_pi
  else
    warn "price-info not reachable — check: ${SSH[*]} 'journalctl -u baja-server -n 40'"
  fi
else
  c "Dry run complete — nothing changed."
fi

ok "Software deploy finished → https://$DOMAIN  (data & config untouched)"
