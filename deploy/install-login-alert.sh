#!/usr/bin/env bash
# Install / update the login-alert watcher on the production host.
#   SERVER=ubuntu@52.87.30.101 SSH_KEY=~/.ssh/baja.pem ./install-login-alert.sh [--test]
set -euo pipefail
SERVER="${SERVER:-ubuntu@52.87.30.101}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/baja.pem}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SERVER")
SCP=(scp -q -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

"${SSH[@]}" "sudo mkdir -p /opt/baja-login-alert && sudo chown ubuntu:ubuntu /opt/baja-login-alert"
"${SCP[@]}" "$HERE/login-alert.js" "$SERVER:/opt/baja-login-alert/login-alert.js"
"${SCP[@]}" "$HERE/baja-login-alert.service" "$SERVER:/tmp/baja-login-alert.service"
"${SSH[@]}" "sudo mv /tmp/baja-login-alert.service /etc/systemd/system/baja-login-alert.service \
  && sudo systemctl daemon-reload && sudo systemctl enable --now baja-login-alert \
  && sudo systemctl restart baja-login-alert && sleep 2 && systemctl is-active baja-login-alert"
if [[ "${1:-}" == "--test" ]]; then
  "${SSH[@]}" "cd /opt/baja-login-alert && NODE_PATH=/opt/baja-server/node_modules LOGIN_ALERT_TO=milton@baja.bio node login-alert.js --test --env-file /opt/baja-server/.env"
fi
echo "installed: journalctl -u baja-login-alert -f"
