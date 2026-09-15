#!/opt/venv/bin/python3
"""Activity per IP address, with the city each address comes from.

Companion to traffic-report.py (top-N tables) and cities-csv.py (one row per
place). This one is one row per ADDRESS: where it is, how much it did, when it
was first and last seen, which signed-in users it carried, what it asked for and
what it called itself. Written as CSV so it can be downloaded and opened in a
spreadsheet; --json for the same rows as JSON.

Reads the nginx access logs (the live one plus whatever rotations logrotate has
kept -- 14 days) and the DB-IP Lite databases in /opt/baja-geo, read LOCALLY. No
address is ever sent anywhere. The logs are root-readable only, so run this
under sudo; fetch-ip-activity.sh does that from a workstation and pulls the file
down.

  --days N          only the last N days                 (default: everything on disk)
  --all             keep bots and the excluded IPs       (default: both dropped)
  --exclude IP      drop an address, repeatable; adds to EXCLUDE_DEFAULT
  --min-requests N  skip addresses with fewer requests   (default 1)
  --city NAME       only addresses located in this city  (case-insensitive substring)
  --country NAME    only addresses in this country       (case-insensitive substring)
  --user EMAIL      only addresses that carried this user (substring)
  --sort FIELD      requests | last_seen | first_seen | city | country  (default requests)
  --top N           stop after N rows                    (default: all)
  --out FILE        where to write                       (default /tmp/oligodesigner-ip-activity.csv)
  --json            write JSON instead of CSV
  --print           also print a short table to stdout
"""
import argparse, collections, csv, glob, gzip, json, os, re, sys, urllib.parse
from datetime import datetime, timedelta, timezone

import maxminddb

GEO_DIR = os.environ.get("BAJA_GEO_DIR", "/opt/baja-geo")
LOG_GLOB = os.environ.get("BAJA_LOG_GLOB", "/var/log/nginx/access.log*")

# The developer's own address (see traffic-report.py).
EXCLUDE_DEFAULT = {"99.174.249.175"}

BOT = re.compile(r"bot|crawl|spider|scan|curl|wget|python-requests|go-http|"
                 r"zgrab|masscan|semrush|ahrefs|bingpreview|yandex|"
                 r"facebookexternal|headlesschrome|okhttp|libwww|java/", re.I)

# combined log format: ip - user [time] "request" status bytes "referer" "agent"
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+) "([^"]*)" "([^"]*)"')
EMAIL_Q = re.compile(r'[?&](?:user|email)=([^&\s"]+)')

TOP_PATHS = 5
TOP_AGENTS = 2

FIELDS = ["ip", "city", "region", "country", "latitude", "longitude",
          "requests", "errors", "bytes", "first_seen_utc", "last_seen_utc",
          "active_days", "bot", "signed_in_users", "users", "top_paths", "user_agents"]


def log_files():
    return sorted(glob.glob(LOG_GLOB), key=os.path.getmtime, reverse=True)


def read_lines(paths):
    for p in paths:
        op = gzip.open if p.endswith(".gz") else open
        try:
            with op(p, "rt", errors="replace") as fh:
                for line in fh:
                    yield line
        except OSError:
            continue


def open_geo():
    city = maxminddb.open_database(os.path.join(GEO_DIR, "dbip-city.mmdb"))
    try:
        country = maxminddb.open_database(os.path.join(GEO_DIR, "dbip-country.mmdb"))
    except (OSError, ValueError):
        country = None
    cache = {}

    def locate(ip):
        if ip in cache:
            return cache[ip]
        c = s = t = lat = lon = None
        try:
            rec = city.get(ip)
            if rec:
                c = (rec.get("country") or {}).get("names", {}).get("en")
                subs = rec.get("subdivisions") or []
                s = (subs[0].get("names") or {}).get("en") if subs else None
                t = (rec.get("city") or {}).get("names", {}).get("en")
                loc = rec.get("location") or {}
                lat, lon = loc.get("latitude"), loc.get("longitude")
            if not c and country is not None:
                rec = country.get(ip)
                if rec:
                    c = (rec.get("country") or {}).get("names", {}).get("en")
        except (ValueError, KeyError):
            pass
        cache[ip] = (c or "unknown", s or "", t or "", lat, lon)
        return cache[ip]

    return locate


def path_of(req):
    # "GET /app/free/editor?user=x HTTP/1.1" -> "/app/free/editor"
    parts = req.split(" ")
    if len(parts) < 2:
        return req[:80]
    return parts[1].split("?", 1)[0][:120]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--hours", type=float, default=0.0)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--min-requests", type=int, default=1)
    ap.add_argument("--city")
    ap.add_argument("--country")
    ap.add_argument("--user")
    ap.add_argument("--sort", default="requests",
                    choices=["requests", "last_seen", "first_seen", "city", "country"])
    ap.add_argument("--top", type=int, default=0)
    ap.add_argument("--out", default="/tmp/oligodesigner-ip-activity.csv")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--print", dest="show", action="store_true")
    args = ap.parse_args()

    excluded = set(args.exclude) | (set() if args.all else EXCLUDE_DEFAULT)
    # --hours is finer than --days; either sets the window, --hours wins when both given.
    if args.hours > 0:
        since = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    elif args.days > 0:
        since = datetime.now(timezone.utc) - timedelta(days=args.days)
    else:
        since = None
    locate = open_geo()

    rows = {}
    total = 0
    for line in read_lines(log_files()):
        m = LINE.match(line)
        if not m:
            continue
        ip, ts, req, status, nbytes, _ref, agent = m.groups()
        total += 1
        try:
            when = datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z")
        except ValueError:
            continue
        if since is not None and when < since:
            continue
        if ip in excluded:
            continue
        is_bot = bool(BOT.search(agent))
        if is_bot and not args.all:
            continue
        r = rows.get(ip)
        if r is None:
            r = rows[ip] = {"requests": 0, "errors": 0, "bytes": 0,
                            "first": when, "last": when, "days": set(), "bot": False,
                            "users": set(), "paths": collections.Counter(),
                            "agents": collections.Counter()}
        r["requests"] += 1
        if status[0] in "45":
            r["errors"] += 1
        if nbytes.isdigit():
            r["bytes"] += int(nbytes)
        if when < r["first"]:
            r["first"] = when
        if when > r["last"]:
            r["last"] = when
        r["days"].add(when.date())
        r["bot"] = r["bot"] or is_bot
        r["paths"][path_of(req)] += 1
        r["agents"][agent[:100]] += 1
        em = EMAIL_Q.search(req)
        if em:
            who = urllib.parse.unquote(em.group(1))
            if "@" in who:
                r["users"].add(who)

    out = []
    for ip, r in rows.items():
        if r["requests"] < args.min_requests:
            continue
        c, s, t, lat, lon = locate(ip)
        if args.city and args.city.lower() not in t.lower():
            continue
        if args.country and args.country.lower() not in c.lower():
            continue
        if args.user and not any(args.user.lower() in u.lower() for u in r["users"]):
            continue
        out.append({
            "ip": ip, "city": t, "region": s, "country": c,
            "latitude": "" if lat is None else round(lat, 4),
            "longitude": "" if lon is None else round(lon, 4),
            "requests": r["requests"], "errors": r["errors"], "bytes": r["bytes"],
            "first_seen_utc": r["first"].strftime("%Y-%m-%d %H:%M"),
            "last_seen_utc": r["last"].strftime("%Y-%m-%d %H:%M"),
            "active_days": len(r["days"]),
            "bot": "yes" if r["bot"] else "",
            "signed_in_users": len(r["users"]),
            "users": "; ".join(sorted(r["users"])),
            "top_paths": "; ".join("%s (%d)" % pn for pn in r["paths"].most_common(TOP_PATHS)),
            "user_agents": " | ".join(a for a, _ in r["agents"].most_common(TOP_AGENTS)),
        })

    key = {"requests": lambda x: -x["requests"],
           "last_seen": lambda x: (x["last_seen_utc"], -x["requests"]),
           "first_seen": lambda x: (x["first_seen_utc"], -x["requests"]),
           "city": lambda x: (x["country"], x["region"], x["city"], -x["requests"]),
           "country": lambda x: (x["country"], -x["requests"])}[args.sort]
    out.sort(key=key, reverse=(args.sort == "last_seen"))
    if args.top > 0:
        out = out[:args.top]

    if args.json:
        with open(args.out, "w") as fh:
            json.dump({"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
                       "days": args.days or None, "lines_read": total,
                       "addresses": out}, fh, indent=2)
    else:
        with open(args.out, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            w.writerows(out)

    print("%d lines read, %d addresses -> %s" % (total, len(out), args.out), file=sys.stderr)

    if args.show:
        print("  %-16s %-40s %9s %6s  %-16s %s" % ("ip", "place", "requests", "users", "last seen", "top path"))
        for r in out[:50]:
            place = ", ".join(p for p in (r["city"], r["region"], r["country"]) if p)
            top = r["top_paths"].split("; ")[0] if r["top_paths"] else ""
            print("  %-16s %-40s %9d %6d  %-16s %s" % (r["ip"], place[:40], r["requests"],
                  r["signed_in_users"], r["last_seen_utc"], top[:40]))


if __name__ == "__main__":
    main()
