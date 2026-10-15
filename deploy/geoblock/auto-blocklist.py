#!/opt/venv/bin/python3
"""Daily: add the worst scanners in the access logs to the geographic block.

Runs ip-activity.py over the last --days of nginx logs and refuses, one /32 at a
time, any address that
  - made at least --min-requests requests, and
  - never carried a signed-in user, and
  - either asked for scanner paths (/.env, /.git, wp-*, *.php, ...) or had more
    than half its requests fail.
Entries go in /etc/nginx/baja-geoblock/blocklist-auto.conf (blocklist.conf stays
hand-maintained) and expire after --expire-days, so a reassigned cloud address is
not refused forever. Addresses already listed in blocklist.conf, blocklist-auto.conf
or allow.conf are skipped -- geo rejects a duplicate key and nginx -t would fail.

nginx is only reloaded if `nginx -t` passes; otherwise the old file is restored.
Never blocks a signed-in address or the developer address (ip-activity drops it).

  auto-blocklist.py --dry-run     show what would change, touch nothing
Cron (installed as /etc/cron.d/baja-autoblock):  17 3 * * * root /opt/venv/bin/python3 /opt/baja-geo/auto-blocklist.py
"""
import argparse, csv, ipaddress, os, re, subprocess, sys, tempfile
from datetime import date, timedelta

DIR = os.environ.get("BAJA_GEOBLOCK_DIR", "/etc/nginx/baja-geoblock")
HERE = os.path.dirname(os.path.abspath(__file__))
AUTO = os.path.join(DIR, "blocklist-auto.conf")
HAND = [os.path.join(DIR, "blocklist.conf"), os.path.join(DIR, "allow.conf")]
PROBE = re.compile(r"wp-|\.env|\.git|\.php|phpmyadmin|xmlrpc|/admin|cgi-bin|actuator|\.aws", re.I)
ENTRY = re.compile(r"^\s*([0-9a-fA-F:.]+(?:/\d+)?)\s+[01]\s*;\s*(?:#\s*(\d{4}-\d{2}-\d{2})\s*(.*))?")
HEADER = ("# Written by auto-blocklist.py -- do not edit by hand (use blocklist.conf).\n"
          "# One \"<address>/32 1;  # <date added> <where>: <requests> req\" per line; entries expire.\n")


def norm(a):
    return a if "/" in a else a + ("/128" if ":" in a else "/32")


def read_entries(path):
    out = []
    try:
        for line in open(path):
            m = ENTRY.match(line)
            if m:
                out.append((norm(m.group(1)), m.group(2), (m.group(3) or "").strip(), line.rstrip("\n")))
    except FileNotFoundError:
        pass
    return out


def blocked_networks():
    """Networks the generated country/city block already refuses (networks.conf)."""
    nets = []
    try:
        for line in open(os.path.join(DIR, "networks.conf")):
            m = re.match(r"^\s*([0-9a-fA-F:.]+/\d+)\s+1\s*;", line)
            if m:
                nets.append(ipaddress.ip_network(m.group(1), strict=False))
    except FileNotFoundError:
        pass
    return nets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--min-requests", type=int, default=300)
    ap.add_argument("--max-new", type=int, default=25)
    ap.add_argument("--expire-days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    today = date.today()

    tmp = tempfile.mktemp(suffix=".csv")
    subprocess.run([sys.executable, os.path.join(HERE, "ip-activity.py"), "--days", str(args.days),
                    "--min-requests", str(args.min_requests), "--out", tmp],
                   check=True, stdout=subprocess.DEVNULL)
    rows = list(csv.DictReader(open(tmp)))
    os.unlink(tmp)

    nets = blocked_networks()
    existing = {e[0] for p in HAND + [AUTO] for e in read_entries(p)}
    cands = []
    for r in rows:
        q, e = int(r["requests"]), int(r["errors"])
        if int(r["signed_in_users"] or 0) > 0 or norm(r["ip"]) in existing:
            continue
        ip = ipaddress.ip_address(r["ip"])
        if any(ip.version == n.version and ip in n for n in nets):
            continue    # already refused by country/city; its "errors" are our own 403s
        if PROBE.search(r["top_paths"]) or e / q > 0.5:
            cands.append(r)
    cands.sort(key=lambda r: -int(r["requests"]))
    cands = cands[:args.max_new]

    # keep unexpired auto entries, drop the rest
    cutoff = today - timedelta(days=args.expire_days)
    kept, expired = [], []
    for ip, added, note, line in read_entries(AUTO):
        (kept if added and date.fromisoformat(added) >= cutoff else expired).append(line)
    new = ["%s/32 1;   # %s %s, %s: %s req" % (r["ip"], today, r["city"], r["country"], r["requests"])
           for r in cands if ":" not in r["ip"]]

    print("%s: %d new, %d kept, %d expired" % (today, len(new), len(kept), len(expired)))
    for l in new: print("  +", l)
    for l in expired: print("  -", l)
    if args.dry_run or not (new or expired):
        return

    old = open(AUTO).read() if os.path.exists(AUTO) else ""
    with open(AUTO, "w") as f:
        f.write(HEADER + "\n".join(kept + new) + "\n")
    t = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if "successful" in t.stderr + t.stdout:
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
        print("nginx reloaded")
    else:
        open(AUTO, "w").write(old)
        print("nginx -t FAILED, restored previous file:\n" + t.stderr[-600:], file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
