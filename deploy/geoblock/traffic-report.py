#!/opt/venv/bin/python3
"""Who hit oligodesigner.com, and from where.

Reads the nginx access logs (the live one plus whatever rotations are still on
disk -- logrotate keeps 14 days) and reports traffic by country, by city, and by
identified user.

Location comes from the DB-IP Lite databases in /opt/baja-geo, read LOCALLY: no
address is ever sent anywhere. They are a monthly snapshot -- refresh-geo.sh
fetches the current one.

The logs are root-readable only, so run this under sudo.

  --days N     only the last N days               (default: everything on disk)
  --top N      rows per table                     (default 20)
  --all        include bots and the excluded IPs  (default: both are dropped)
  --exclude IP drop an address, repeatable; adds to EXCLUDE_DEFAULT
  --json       machine-readable instead of tables
"""
import argparse, collections, glob, gzip, json, os, re, sys, urllib.parse
from datetime import datetime, timedelta, timezone

import maxminddb

GEO_DIR = "/opt/baja-geo"
LOG_GLOB = "/var/log/nginx/access.log*"

# The developer's own address. It is ~83% of all requests, and leaving it in makes
# every table a description of one person in Del Mar rather than of the users.
EXCLUDE_DEFAULT = {"99.174.249.175"}

BOT = re.compile(r"bot|crawl|spider|scan|curl|wget|python-requests|go-http|"
                 r"zgrab|masscan|semrush|ahrefs|bingpreview|yandex|"
                 r"facebookexternal|headlesschrome|okhttp|libwww|java/", re.I)

# combined log format: ip - user [time] "request" status bytes "referer" "agent"
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+) "([^"]*)" "([^"]*)"')
EMAIL_Q = re.compile(r'[?&](?:user|email)=([^&\s"]+)')


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    excluded = set(args.exclude) | (set() if args.all else EXCLUDE_DEFAULT)
    since = datetime.now(timezone.utc) - timedelta(days=args.days) if args.days > 0 else None

    city = maxminddb.open_database(os.path.join(GEO_DIR, "dbip-city.mmdb"))
    country = maxminddb.open_database(os.path.join(GEO_DIR, "dbip-country.mmdb"))

    # Looking an address up twice costs the same as looking it up once, and is the
    # difference between a second and a minute over half a million lines.
    cache = {}

    def locate(ip):
        if ip in cache:
            return cache[ip]
        c = s = t = None
        try:
            rec = city.get(ip)
            if rec:
                c = (rec.get("country") or {}).get("names", {}).get("en")
                subs = rec.get("subdivisions") or []
                s = (subs[0].get("names") or {}).get("en") if subs else None
                t = (rec.get("city") or {}).get("names", {}).get("en")
            if not c:
                rec = country.get(ip)
                if rec:
                    c = (rec.get("country") or {}).get("names", {}).get("en")
        except (ValueError, KeyError):
            pass
        cache[ip] = (c or "unknown", s, t)
        return cache[ip]

    req_country = collections.Counter()
    ips_country = collections.defaultdict(set)
    req_city = collections.Counter()
    ips_city = collections.defaultdict(set)
    user_req = collections.Counter()
    user_places = collections.defaultdict(collections.Counter)
    all_ips, bot_ips = set(), set()
    total = kept = bots = 0
    first = last = None

    for line in read_lines(log_files()):
        m = LINE.match(line)
        if not m:
            continue
        ip, ts, req, status, _b, _ref, agent = m.groups()
        total += 1
        when = None
        if since is not None:
            try:
                when = datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z")
            except ValueError:
                continue
            if when < since:
                continue
        # Lexical min/max on the raw stamp would order Apr before Jan, so the window
        # is tracked as real datetimes and only formatted at the end.
        if when is None:
            try:
                when = datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z")
            except ValueError:
                when = None
        if when is not None:
            if first is None or when < first:
                first = when
            if last is None or when > last:
                last = when
        if ip in excluded:
            continue
        if BOT.search(agent):
            bots += 1
            bot_ips.add(ip)
            if not args.all:
                continue
        kept += 1
        all_ips.add(ip)
        c, s, t = locate(ip)
        req_country[c] += 1
        ips_country[c].add(ip)
        place = "%s, %s%s" % (t or "unknown city", (s + ", ") if s else "", c)
        req_city[place] += 1
        ips_city[place].add(ip)
        em = EMAIL_Q.search(req)
        if em:
            who = urllib.parse.unquote(em.group(1))
            if "@" in who:
                user_req[who] += 1
                user_places[who][place] += 1

    fmt = lambda d: d.strftime("%Y-%m-%d %H:%M %Z") if d else "?"
    out = {
        "window": {"from": fmt(first), "to": fmt(last), "days_arg": args.days or None},
        "requests_read": total, "requests_counted": kept,
        "bot_requests": bots, "bot_ips": len(bot_ips),
        "unique_ips": len(all_ips), "excluded_ips": sorted(excluded),
        "countries": [{"country": c, "requests": n, "unique_ips": len(ips_country[c])}
                      for c, n in req_country.most_common()],
        "cities": [{"place": p, "requests": n, "unique_ips": len(ips_city[p])}
                   for p, n in req_city.most_common()],
        "users": [{"user": u, "requests": n,
                   "places": [p for p, _ in user_places[u].most_common(3)]}
                  for u, n in user_req.most_common()],
    }
    if args.json:
        json.dump(out, sys.stdout, indent=2)
        print()
        return

    print("oligodesigner.com traffic   %s  ->  %s" % (fmt(first), fmt(last)))
    print("  %d requests read, %d counted, %d unique IPs" % (total, kept, len(all_ips)))
    print("  %d bot requests from %d IPs%s" % (bots, len(bot_ips),
          " (included)" if args.all else " (excluded)"))
    if excluded:
        print("  excluded addresses: %s" % ", ".join(sorted(excluded)))

    print("\nBY COUNTRY")
    print("  %-34s %10s %8s" % ("country", "requests", "IPs"))
    for r in out["countries"][:args.top]:
        print("  %-34s %10d %8d" % (r["country"][:34], r["requests"], r["unique_ips"]))

    print("\nBY CITY")
    print("  %-46s %10s %8s" % ("place", "requests", "IPs"))
    for r in out["cities"][:args.top]:
        print("  %-46s %10d %8d" % (r["place"][:46], r["requests"], r["unique_ips"]))

    if out["users"]:
        print("\nBY USER   (email as it appears in the request)")
        print("  %-36s %9s  %s" % ("user", "requests", "seen from"))
        for r in out["users"][:args.top]:
            print("  %-36s %9d  %s" % (r["user"][:36], r["requests"], "; ".join(r["places"])[:58]))


if __name__ == "__main__":
    main()
