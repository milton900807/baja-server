#!/usr/bin/env bash
# =============================================================================
#  provision.sh — ONE-TIME EC2 host setup for oligodesigner.com (host model).
#
#  Run this ON the server (not your laptop), from inside a cloned baja-server:
#     git clone <baja-server repo> ~/baja-server
#     cd ~/baja-server/deploy && ./provision.sh
#
#  It installs Node 20 + nginx + certbot + python venv, creates the deploy
#  directories, installs the systemd unit and nginx site, and issues TLS.
#  Afterwards, deploy code from your laptop with deploy.sh. Idempotent —
#  safe to re-run.
#
#  Override via env:  DOMAIN=oligodesigner.com  EMAIL=milton@baja.bio  ./provision.sh
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-oligodesigner.com}"
EMAIL="${EMAIL:-milton@baja.bio}"
APP_USER="${APP_USER:-$(whoami)}"           # systemd unit runs as this user
WEB_DIR="/eln"
API_DIR="/opt/baja-server"
APPS_DIR="/opt/baja-apps"
DATA_DIR="$API_DIR/reference_data"
VENV_DIR="/opt/venv"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c(){ printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "run this ON the Ubuntu server, not your laptop"
[[ -f "$HERE/baja-server.service" && -f "$HERE/nginx-oligodesigner.conf" ]] \
  || die "run from baja-server/deploy/ (needs baja-server.service + nginx-oligodesigner.conf)"

# ---- 1. packages ------------------------------------------------------------
c "Installing packages (Node 20, nginx, certbot, python venv)…"
sudo apt-get update -y
sudo apt-get install -y nginx python3 python3-venv git curl ca-certificates dnsutils
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y certbot
ok "node $(node -v), nginx $(nginx -v 2>&1 | sed 's|.*/||'), certbot present"

# ---- 2. directories + venv --------------------------------------------------
c "Creating deploy directories…"
sudo mkdir -p "$WEB_DIR" "$API_DIR" "$APPS_DIR" "$DATA_DIR" /var/www/certbot
sudo chown -R "$APP_USER":"$APP_USER" "$WEB_DIR" "$API_DIR" "$APPS_DIR"
[[ -d "$VENV_DIR" ]] || sudo python3 -m venv "$VENV_DIR"
sudo chown -R "$APP_USER":"$APP_USER" "$VENV_DIR"
# Install the exec venv's runtime wheels. Without these the server's python3
# subprocesses fail: no numpy -> off-target search crashes; no requests -> the
# Claude gene resolver / SNP info can't reach Anthropic. Best-effort (a fresh
# host may lack build tools for optional wheels), but numpy+requests are pure/
# prebuilt and should always land.
VENV_REQ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/venv-requirements.txt"
if [[ -f "$VENV_REQ" ]]; then
  "$VENV_DIR/bin/pip" install --upgrade pip >/dev/null 2>&1 || true
  "$VENV_DIR/bin/pip" install -r "$VENV_REQ" || warn "venv pip install had failures (see above)"
fi
ok "dirs ready ($WEB_DIR, $API_DIR, $APPS_DIR, $DATA_DIR)"

# ---- 3. secrets placeholder -------------------------------------------------
if [[ ! -f "$API_DIR/.env" ]]; then
  warn "No $API_DIR/.env — writing a template. FILL IT IN before the API will work."
  cat > "$API_DIR/.env" <<EOF
# Fill these with your real values (live for production).
STRIPE_SECRET_KEY=sk_test_CHANGE_ME
STRIPE_PRICE_ID=price_CHANGE_ME
STRIPE_WEBHOOK_SECRET=whsec_CHANGE_ME
GOOGLE_CLIENT_ID=CHANGE_ME
GOOGLE_CLIENT_SECRET=CHANGE_ME
FACEBOOK_APP_ID=CHANGE_ME
FACEBOOK_APP_SECRET=CHANGE_ME
PYTHONPATH=$APPS_DIR/py/ion-lib
EOF
  chmod 600 "$API_DIR/.env"
else
  ok ".env already present (left untouched)"
fi

# ---- 4. systemd unit --------------------------------------------------------
c "Installing systemd unit (runs as $APP_USER)…"
sudo cp "$HERE/baja-server.service" /etc/systemd/system/baja-server.service
# match the unit's User=/venv PATH to this host if they differ from the defaults
sudo sed -i "s|^User=.*|User=$APP_USER|; s|^Group=.*|Group=$APP_USER|; s|/opt/venv|$VENV_DIR|g" \
  /etc/systemd/system/baja-server.service
sudo systemctl daemon-reload
sudo systemctl enable baja-server            # don't start yet — no code until deploy.sh
ok "unit installed + enabled (start happens after first deploy)"

# ---- 5. TLS certificate -----------------------------------------------------
c "Checking DNS before issuing TLS…"
RESOLVED="$(dig +short "$DOMAIN" | tail -1 || true)"
MYIP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com || echo '?')"
if [[ "$RESOLVED" != "$MYIP" ]]; then
  warn "$DOMAIN resolves to '$RESOLVED' but this box is '$MYIP'."
  warn "Point GoDaddy A records (@ and www) at $MYIP, wait for propagation, then re-run."
  die  "aborting before certbot (Let's Encrypt would fail on the domain check)"
fi
ok "DNS OK — $DOMAIN → $MYIP"

if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  c "Issuing certificate (standalone; nginx paused briefly)…"
  sudo systemctl stop nginx || true
  sudo certbot certonly --standalone \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" \
    --pre-hook  'systemctl stop nginx' \
    --post-hook 'systemctl start nginx'
  ok "certificate issued (auto-renew via certbot timer + nginx pre/post hooks)"
else
  ok "certificate already present for $DOMAIN"
fi

# ---- 6. nginx site ----------------------------------------------------------
c "Installing nginx site…"
sudo cp "$HERE/nginx-oligodesigner.conf" /etc/nginx/conf.d/oligodesigner.conf
sudo rm -f /etc/nginx/sites-enabled/default    # drop the default welcome site
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
ok "nginx serving $WEB_DIR with TLS"

# ---- done -------------------------------------------------------------------
echo
ok "Provisioning complete. This host is ready for deploys."
cat <<EOF

Next:
  1. If the template .env was created, edit it now:
        nano $API_DIR/.env      # then: chmod 600 $API_DIR/.env
  2. From your LAPTOP, deploy the built artifacts:
        cd baja-server/deploy
        SERVER=$APP_USER@$MYIP SSH_KEY=~/.ssh/baja.pem ./deploy.sh
  3. Verify:
        curl -s https://$DOMAIN/stripe/price-info
EOF
