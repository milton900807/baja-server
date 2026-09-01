# Deploying oligodesigner.com on AWS (EC2 + nginx + systemd)

Single-instance setup that matches the existing nginx/systemd pattern. For higher
scale you'd split into ALB + Auto Scaling later, but this gets you live cleanly.

```
Internet → Route 53 (oligodesigner.com) → EC2 Elastic IP
             └─ nginx :80/:443 (TLS)  ┬─ /eln  Angular SPA (static)
                                       └─ 127.0.0.1:8080  Node API + socket.io → python3
```

---

## 1. Launch the EC2 instance
- **AMI:** Ubuntu Server 22.04 LTS (matches the baja-server Dockerfile base).
- **Type:** `t3.large` min (the Node heap is set to 16 GB; use `m6i.xlarge`/`r6i` if
  you run torch/off-target indexing on-box). Give it **≥ 40 GB gp3** disk.
- **Key pair:** create/download one for SSH.
- **Elastic IP:** allocate one and associate it — you need a stable IP for DNS.

## 2. Security group (firewall)
| Port | Source | Why |
|------|--------|-----|
| 22   | your IP only | SSH |
| 80   | 0.0.0.0/0 | HTTP → redirects to HTTPS + ACME challenge |
| 443  | 0.0.0.0/0 | HTTPS |
| 8080 | **do NOT expose** | Node stays on localhost, reached only via nginx |

## 3. Point the domain at the instance
Use **Route 53** (or your registrar's DNS):
- If registered elsewhere, create a Route 53 **hosted zone** for `oligodesigner.com`
  and set the 4 NS records at your registrar.
- Records (A → the Elastic IP):
  - `oligodesigner.com`      → A → `<ELASTIC_IP>`
  - `www.oligodesigner.com`  → A → `<ELASTIC_IP>`
- Wait for propagation: `dig +short oligodesigner.com` should return the Elastic IP.

## 4. Install the runtime
```bash
sudo apt-get update
sudo apt-get install -y nginx python3 python3-venv git
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
# certbot for Let's Encrypt TLS
sudo apt-get install -y certbot python3-certbot-nginx
# Python venv the API re-execs into (torch etc.)
sudo python3 -m venv /opt/venv
sudo /opt/venv/bin/pip install -r /opt/baja-server/py/requirements.txt   # if present
```

## 5. Deploy the code
```bash
sudo mkdir -p /opt/baja-server /eln
sudo chown -R ubuntu:ubuntu /opt/baja-server /eln

# --- API ---
git clone <baja-server repo> /opt/baja-server
cd /opt/baja-server
npm ci && npm run build

# --- lionscript library (resolved by exec() at runtime) ---
git clone <baja-apps repo> /opt/baja-apps    # keep the path your server expects

# --- frontend ---
git clone <baja repo> /tmp/baja && cd /tmp/baja
npm ci --legacy-peer-deps
ng build --base-href / --configuration production
cp -r dist/* /eln/
cp config/env-prod.js /eln/assets/env.js      # production env.js (see step 7)
```

## 6. Secrets — create `/opt/baja-server/.env`
Never commit this. Copy your values and lock permissions:
```bash
sudo chown ubuntu:ubuntu /opt/baja-server/.env
chmod 600 /opt/baja-server/.env
```
Must contain the **live** values before go-live:
```
STRIPE_SECRET_KEY=sk_live_…
STRIPE_PRICE_ID=price_…            # live-mode price
STRIPE_WEBHOOK_SECRET=whsec_…
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…             # ROTATED (the old one was exposed)
FACEBOOK_APP_ID=…
FACEBOOK_APP_SECRET=…
PYTHONPATH=/opt/baja-apps/py/ion-lib
```

## 7. Production `env.js` (frontend, public values only)
```js
window.env = {
  apiUrl: 'https://oligodesigner.com',            // same-origin → no CORS
  oidcRedirectUri: 'https://oligodesigner.com/auth/callback',
  auth: '…',
  oidc: {
    google:    { clientId: '…' },
    microsoft: { clientId: '…', tenant: 'common' },
    facebook:  { clientId: '…' }
  },
  authTokenProxy: 'https://oligodesigner.com/oidc/token'
};
```

## 8. Start the services
```bash
sudo cp /opt/baja-server/deploy/baja-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now baja-server

sudo cp /opt/baja-server/deploy/nginx-oligodesigner.conf /etc/nginx/conf.d/oligodesigner.conf
sudo mkdir -p /var/www/certbot
```

## 9. Issue TLS
```bash
# Nginx must be reloadable first (comment the ssl_certificate lines OR let certbot add them)
sudo certbot --nginx -d oligodesigner.com -d www.oligodesigner.com \
     --redirect --agree-tos -m milton@baja.bio
sudo nginx -t && sudo systemctl reload nginx
# auto-renew is installed as a timer; test it:
sudo certbot renew --dry-run
```
> The provided `nginx-oligodesigner.conf` already references
> `/etc/letsencrypt/live/oligodesigner.com/…` — if you let certbot manage certs,
> keep those paths and just reload.

## 10. Go-live switches (external consoles)
- **Google / Facebook / Microsoft:** add redirect URI
  `https://oligodesigner.com/auth/callback` to each app registration.
- **Stripe:** live key + live price in `.env`; add a **webhook** →
  `https://oligodesigner.com/stripe/webhook` (set `STRIPE_WEBHOOK_SECRET`);
  register `oligodesigner.com` under **Payment Method Domains** for Apple/Google Pay.

## 11. Smoke test
```bash
curl -s https://oligodesigner.com/stripe/price-info
curl -s "https://oligodesigner.com/stripe/subscription-status?email=you@domain"
```
Then in a browser: OAuth sign-in → subscribe ($1 test / live) → editor gate opens.

---

### Redeploys later
```bash
cd /opt/baja-server && git pull && npm ci && npm run build && sudo systemctl restart baja-server
cd /tmp/baja && git pull && ng build --configuration production && cp -r dist/* /eln/   # env.js stays
```
Because config lives in `.env` + `env.js` (not the build), rollback = restore the
previous `/eln` + `dist` and `systemctl restart baja-server`.

## Additional domain: genome.bio

`genome.bio` (and `www.genome.bio`) point at the same instance and REDIRECT to
`oligodesigner.com`. Config: `nginx-genome-bio.conf` -> `/etc/nginx/conf.d/genome-bio.conf`.

    sudo certbot certonly --webroot -w /var/www/certbot -d genome.bio -d www.genome.bio --cert-name genome.bio
    sudo cp nginx-genome-bio.conf /etc/nginx/conf.d/genome-bio.conf
    sudo nginx -t && sudo systemctl reload nginx

It is a redirect rather than a second origin on purpose: `assets/env.js` hard-codes
`apiUrl = https://oligodesigner.com`, so an app served from genome.bio would call the API
cross-origin, and the OIDC redirect_uri is registered per origin. Serving the app there
needs a per-host apiUrl (and deploy.sh no longer overwriting env.js with the absolute one),
the new origin registered with the OIDC provider, and a check of the Stripe return URLs.
