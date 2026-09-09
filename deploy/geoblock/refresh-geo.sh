#!/bin/bash
# Refresh the DB-IP Lite databases used by traffic-report.py.
#
# They are published monthly and the URL carries the month, so this asks for the
# current one and falls back to the previous month when it has not been cut yet
# (early in a month, and whenever a release slips).
#
# Downloads to a temp name and only moves it into place once the file is complete
# and readable -- a half-downloaded .mmdb left where the reader expects a good one
# would break every report until someone noticed.
#
# Free, CC-BY 4.0, no account and no licence key. Attribution belongs on anything
# published from it: "IP geolocation by DB-IP" (https://db-ip.com).
set -u
GEO_DIR=/opt/baja-geo
PY=/opt/venv/bin/python3
ok=0

for kind in country city; do
    got=""
    for offset in 0 1; do
        month=$(date -u -d "-${offset} month" +%Y-%m)
        url="https://download.db-ip.com/free/dbip-${kind}-lite-${month}.mmdb.gz"
        tmp="${GEO_DIR}/.dbip-${kind}.${month}.gz"
        if curl -fsS -m 600 -o "$tmp" "$url"; then
            if gunzip -tf "$tmp" 2>/dev/null && gunzip -cf "$tmp" > "${tmp%.gz}.mmdb"; then
                if "$PY" -c "import maxminddb,sys; maxminddb.open_database(sys.argv[1]).get('8.8.8.8')" \
                        "${tmp%.gz}.mmdb" >/dev/null 2>&1; then
                    mv -f "${tmp%.gz}.mmdb" "${GEO_DIR}/dbip-${kind}.mmdb"
                    echo "  ${kind}: updated to ${month}"
                    got=1
                fi
            fi
            rm -f "$tmp" "${tmp%.gz}.mmdb"
        fi
        [ -n "$got" ] && break
    done
    if [ -n "$got" ]; then ok=$((ok+1)); else echo "  ${kind}: NOT updated (kept the copy on disk)"; fi
done

[ "$ok" -eq 2 ]
