#!/opt/venv/bin/python3
"""Every city in the retained nginx logs, as CSV.

Same parsing, exclusions and bot filter as traffic-report.py; one row per place
rather than a top-N table, with the columns split out so the file can be sorted,
filtered or mapped. Bots and the developer's own address are dropped -- pass
--all to keep them.
"""
import argparse, csv, glob, gzip, os, re, urllib.parse
from datetime import datetime, timedelta, timezone
import maxminddb

GEO_DIR = "/opt/baja-geo"
LOG_GLOB = "/var/log/nginx/access.log*"
EXCLUDE_DEFAULT = {"99.174.249.175"}
BOT = re.compile(r"bot|crawl|spider|scan|curl|wget|python-requests|go-http|"
                 r"zgrab|masscan|semrush|ahrefs|bingpreview|yandex|"
                 r"facebookexternal|headlesschrome|okhttp|libwww|java/", re.I)
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+) "([^"]*)" "([^"]*)"')
EMAIL_Q = re.compile(r'[?&](?:user|email)=([^&\s"]+)')

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=int, default=0)
ap.add_argument("--all", action="store_true")
ap.add_argument("--out", default="/tmp/oligodesigner-cities.csv")
args = ap.parse_args()

excluded = set() if args.all else EXCLUDE_DEFAULT
since = datetime.now(timezone.utc) - timedelta(days=args.days) if args.days > 0 else None
city_db = maxminddb.open_database(os.path.join(GEO_DIR, "dbip-city.mmdb"))
country_db = maxminddb.open_database(os.path.join(GEO_DIR, "dbip-country.mmdb"))

cache = {}


def locate(ip):
    if ip in cache:
        return cache[ip]
    c = s = t = lat = lon = None
    try:
        rec = city_db.get(ip)
        if rec:
            c = (rec.get("country") or {}).get("names", {}).get("en")
            subs = rec.get("subdivisions") or []
            s = (subs[0].get("names") or {}).get("en") if subs else None
            t = (rec.get("city") or {}).get("names", {}).get("en")
            loc = rec.get("location") or {}
            lat, lon = loc.get("latitude"), loc.get("longitude")
        if not c:
            rec = country_db.get(ip)
            if rec:
                c = (rec.get("country") or {}).get("names", {}).get("en")
    except (ValueError, KeyError):
        pass
    cache[ip] = (c or "unknown", s or "", t or "", lat, lon)
    return cache[ip]


rows = {}
for p in sorted(glob.glob(LOG_GLOB), key=os.path.getmtime, reverse=True):
    op = gzip.open if p.endswith(".gz") else open
    try:
        fh = op(p, "rt", errors="replace")
    except OSError:
        continue
    with fh:
        for line in fh:
            m = LINE.match(line)
            if not m:
                continue
            ip, ts, req, _st, _b, _r, agent = m.groups()
            try:
                when = datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z")
            except ValueError:
                continue
            if since is not None and when < since:
                continue
            if ip in excluded:
                continue
            if not args.all and BOT.search(agent):
                continue
            c, s, t, lat, lon = locate(ip)
            key = (c, s, t)
            r = rows.get(key)
            if r is None:
                r = rows[key] = {"requests": 0, "ips": set(), "users": set(),
                                 "first": when, "last": when, "lat": lat, "lon": lon}
            r["requests"] += 1
            r["ips"].add(ip)
            if when < r["first"]:
                r["first"] = when
            if when > r["last"]:
                r["last"] = when
            em = EMAIL_Q.search(req)
            if em:
                who = urllib.parse.unquote(em.group(1))
                if "@" in who:
                    r["users"].add(who)

with open(args.out, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["country", "region", "city", "requests", "unique_ips",
                "signed_in_users", "users", "first_seen_utc", "last_seen_utc",
                "latitude", "longitude"])
    for (c, s, t), r in sorted(rows.items(), key=lambda kv: -kv[1]["requests"]):
        w.writerow([c, s, t, r["requests"], len(r["ips"]), len(r["users"]),
                    "; ".join(sorted(r["users"])),
                    r["first"].strftime("%Y-%m-%d %H:%M"),
                    r["last"].strftime("%Y-%m-%d %H:%M"),
                    "" if r["lat"] is None else round(r["lat"], 4),
                    "" if r["lon"] is None else round(r["lon"], 4)])

print("%d places -> %s" % (len(rows), args.out))
