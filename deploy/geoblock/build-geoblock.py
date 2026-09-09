#!/opt/venv/bin/python3
"""Turn the DB-IP databases into an nginx address list for /etc/nginx/baja-geoblock.

WHAT THIS PRODUCES

    networks.conf   one "<cidr> 1;" line per network in a blocked place, included
                    by the `geo $baja_blocked` block in
                    /etc/nginx/conf.d/00-baja-geoblock.conf

The places to block live in rules.json, not in this file, so changing the list is
an edit to data and a re-run rather than a code change:

    {"block": [{"country_iso": "AD"},
               {"country_iso": "ID", "city": "Jakarta"}]}

A rule matches on country_iso, and optionally narrows to city and/or region. A
country-only rule is read from the (small, fast) country database; anything
naming a city needs the city database, which is 14 million networks and takes a
couple of minutes to walk.

WHY A GENERATED LIST RATHER THAN A GEOIP MODULE

nginx can look addresses up in an .mmdb directly with libnginx-mod-http-geoip2,
which would stay current with the database on its own. That means installing a
module into the running web server. A generated `geo` block needs no module at
all -- nginx builds a radix tree from it and matching costs the same -- at the
price of having to be rebuilt when the database is refreshed. refresh-geo.sh
calls this, so that rebuild is not a thing anyone has to remember.

SAFETY

  - writes to a temp file and moves it into place only once it is complete, so a
    failed run cannot leave nginx including half a list
  - refuses to write a list that would match an address in keep-out.txt (by
    default the developer's own), because the first thing a bad rule does is
    lock out the person who wrote it
  - never touches nginx itself: install-geoblock.sh reloads, this only builds
"""
import argparse, ipaddress, json, os, sys, tempfile
import maxminddb

GEO_DIR = "/opt/baja-geo"
OUT_DIR = "/etc/nginx/baja-geoblock"


def load_rules(path):
    with open(path) as fh:
        cfg = json.load(fh)
    rules = cfg.get("block") or []
    if not rules:
        sys.exit("rules.json lists nothing to block")
    for r in rules:
        if not r.get("country_iso"):
            sys.exit("every rule needs a country_iso: %r" % (r,))
    return rules


def describe(r):
    bits = [r["country_iso"]]
    if r.get("region"):
        bits.append(r["region"])
    if r.get("city"):
        bits.append(r["city"])
    return " / ".join(bits)


def matches(rec, r):
    if (rec.get("country") or {}).get("iso_code") != r["country_iso"]:
        return False
    if r.get("city"):
        if (rec.get("city") or {}).get("names", {}).get("en") != r["city"]:
            return False
    if r.get("region"):
        subs = rec.get("subdivisions") or []
        name = (subs[0].get("names") or {}).get("en") if subs else None
        if name != r["region"]:
            return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules", default=os.path.join(OUT_DIR, "rules.json"))
    ap.add_argument("--out", default=os.path.join(OUT_DIR, "networks.conf"))
    ap.add_argument("--keep-out", default=os.path.join(OUT_DIR, "keep-out.txt"))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    rules = load_rules(args.rules)
    city_rules = [r for r in rules if r.get("city") or r.get("region")]
    country_rules = [r for r in rules if not (r.get("city") or r.get("region"))]

    say = (lambda *a: None) if args.quiet else (lambda *a: print(*a))

    nets, per_rule = [], {describe(r): 0 for r in rules}

    def scan(db_path, rule_set, label):
        if not rule_set:
            return
        say("  scanning %s for %s" % (label, ", ".join(describe(r) for r in rule_set)))
        reader = maxminddb.open_database(db_path)
        for net, rec in reader:
            if not rec:
                continue
            for r in rule_set:
                if matches(rec, r):
                    nets.append(str(net))
                    per_rule[describe(r)] += 1
                    break

    scan(os.path.join(GEO_DIR, "dbip-country.mmdb"), country_rules, "the country database")
    scan(os.path.join(GEO_DIR, "dbip-city.mmdb"), city_rules, "the city database")

    if not nets:
        sys.exit("no networks matched any rule -- refusing to write an empty list")

    # THE LOCKOUT CHECK. A rule that is slightly wrong -- a country code typo, a
    # city name that also exists somewhere else -- can match far more than it was
    # meant to. Anything in keep-out.txt must not be in the result, and finding it
    # there means the rules are wrong, not that the address needs an exemption.
    keep_out = []
    if os.path.exists(args.keep_out):
        with open(args.keep_out) as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip()
                if line:
                    keep_out.append(line)
    if keep_out:
        parsed = [ipaddress.ip_network(n) for n in nets]
        for addr in keep_out:
            a = ipaddress.ip_address(addr)
            for n in parsed:
                if a.version == n.version and a in n:
                    sys.exit("REFUSING TO WRITE: %s is in the block list via %s.\n"
                             "The rules match more than they should -- fix rules.json."
                             % (addr, n))
        say("  keep-out addresses checked, none are blocked: %s" % ", ".join(keep_out))

    tmp = tempfile.NamedTemporaryFile("w", dir=os.path.dirname(args.out),
                                      prefix=".networks.", suffix=".conf", delete=False)
    try:
        with tmp:
            tmp.write("# GENERATED by /opt/baja-geo/build-geoblock.py -- do not edit.\n")
            tmp.write("# Rebuild after refreshing the DB-IP databases; the addresses in a\n")
            tmp.write("# place change from month to month.\n")
            for d, n in sorted(per_rule.items()):
                tmp.write("#   %-28s %7d networks\n" % (d, n))
            tmp.write("#   %-28s %7d networks\n" % ("TOTAL", len(nets)))
            for n in nets:
                tmp.write("%s 1;\n" % n)
        os.chmod(tmp.name, 0o644)
        os.replace(tmp.name, args.out)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise

    for d, n in sorted(per_rule.items()):
        say("  %-28s %7d networks" % (d, n))
    say("  %-28s %7d networks -> %s" % ("TOTAL", len(nets), args.out))


if __name__ == "__main__":
    main()
