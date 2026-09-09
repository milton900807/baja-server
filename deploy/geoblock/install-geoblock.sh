#!/bin/bash
# Wire the geographic block into nginx, or take it back out again.
#
#   install-geoblock.sh install    add the include to every TLS server block
#   install-geoblock.sh status     say what is in place and what is blocked
#   install-geoblock.sh disable    stop blocking, leave the plumbing installed
#   install-geoblock.sh enable     start blocking again
#   install-geoblock.sh uninstall  remove the includes and restore the backups
#
# WHY IT IS SAFE TO RUN ON A LIVE SERVER
#
#   - every site config is copied to <file>.pre-geoblock before it is touched,
#     and uninstall puts those copies back
#   - `nginx -t` runs before any reload, and a failed test restores the backups
#     and reloads the old config rather than leaving the site down
#   - only TLS server blocks get the include. Port 80 is left alone so the
#     Let's Encrypt HTTP-01 challenge cannot be refused, which would eventually
#     take the certificate down along with the site
#   - `disable` empties enforce.conf. Blocking stops without editing a single
#     site config, which is the fastest way back if this refuses someone real
set -uo pipefail

DIR=/etc/nginx/baja-geoblock
CONFD=/etc/nginx/conf.d
# A WILDCARD, and not for tidiness. nginx treats a literal `include` of a file that does
# not exist as a FATAL error -- the config test fails and the server will not start -- while
# an include whose glob matches nothing is fine. These lines end up in the site configs, and
# the site configs are templates that get deployed to other machines; a literal include
# would mean any machine without /etc/nginx/baja-geoblock bricks nginx on first start.
# Matching exactly one file, it behaves identically to the literal form here.
INCLUDE_LINE='    include /etc/nginx/baja-geoblock/enforce*.conf;   # geographic block'
# Without the .conf, so the marker recognises both this form and the literal one an earlier
# install wrote -- otherwise `install` would add a second include beside the first.
MARKER='baja-geoblock/enforce'

die() { echo "ERROR: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run this with sudo"; }

configs() { ls "$CONFD"/*.conf 2>/dev/null | grep -v '00-baja-geoblock.conf'; }

backup_all() {
    for f in $(configs); do
        [ -f "$f.pre-geoblock" ] || cp -p "$f" "$f.pre-geoblock"
    done
}

restore_all() {
    for f in $(configs); do
        [ -f "$f.pre-geoblock" ] && cp -p "$f.pre-geoblock" "$f"
    done
}

# Add the include as the first line of every server block that listens on 443.
# awk rather than sed: the insertion point is "the server block that contained a
# 443 listen", which is a decision about a block, not about one line.
add_includes() {
    for f in $(configs); do
        grep -q "$MARKER" "$f" && continue
        awk -v line="$INCLUDE_LINE" '
            /^[[:space:]]*server[[:space:]]*\{/ { inblk=1; buf=$0; n=0; next }
            inblk {
                buf = buf "\n" $0
                if ($0 ~ /listen[^;]*443/) tls=1
                if ($0 ~ /^[[:space:]]*\}[[:space:]]*$/) {
                    # end of the server block: emit it, with the include placed
                    # just after the opening brace when this block is TLS
                    split(buf, L, "\n")
                    print L[1]
                    if (tls) print line
                    for (i = 2; i <= length(L); i++) print L[i]
                    inblk=0; tls=0; buf=""
                    next
                }
                next
            }
            { print }
        ' "$f" > "$f.new" && mv "$f.new" "$f"
    done
}

remove_includes() {
    for f in $(configs); do
        grep -q "$MARKER" "$f" || continue
        grep -v "$MARKER" "$f" > "$f.new" && mv "$f.new" "$f"
    done
}

test_and_reload() {
    if nginx -t 2>&1 | tail -2 | grep -q "successful"; then
        systemctl reload nginx && echo "  nginx reloaded"
        return 0
    fi
    echo "  nginx -t FAILED -- rolling back" >&2
    nginx -t 2>&1 | tail -5 >&2
    restore_all
    rm -f "$CONFD/00-baja-geoblock.conf"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    return 1
}

case "${1:-status}" in

install)
    need_root
    [ -f "$DIR/networks.conf" ] || die "no $DIR/networks.conf -- run build-geoblock.py first"
    [ -s "$DIR/networks.conf" ] || die "$DIR/networks.conf is empty"
    cp -p "$DIR/00-baja-geoblock.conf" "$CONFD/00-baja-geoblock.conf"
    backup_all
    add_includes
    echo "  include added to the TLS server blocks in:"
    for f in $(configs); do grep -q "$MARKER" "$f" && echo "    $f"; done
    test_and_reload || die "install rolled back"
    echo "  blocking is LIVE"
    ;;

uninstall)
    need_root
    remove_includes
    rm -f "$CONFD/00-baja-geoblock.conf"
    test_and_reload || die "uninstall left nginx unhappy -- check nginx -t"
    echo "  geographic blocking removed (files under $DIR are left in place)"
    ;;

disable)
    need_root
    : > "$DIR/enforce.conf"
    echo "# Blocking DISABLED. Restore with: install-geoblock.sh enable" > "$DIR/enforce.conf"
    test_and_reload || die "could not reload"
    echo "  blocking is OFF ($DIR/enforce.conf emptied; the address list is still built)"
    ;;

enable)
    need_root
    cp -p "$DIR/enforce.conf.full" "$DIR/enforce.conf" 2>/dev/null \
        || die "no $DIR/enforce.conf.full to restore from"
    test_and_reload || die "could not reload"
    echo "  blocking is ON"
    ;;

status)
    echo "rules:"
    sed -n 's/.*"country_iso": *"\([A-Z]*\)".*"city": *"\([^"]*\)".*/  \1 \/ \2/p;
            s/.*"country_iso": *"\([A-Z]*\)"[^c]*}.*/  \1 (whole country)/p' "$DIR/rules.json" 2>/dev/null
    echo "address list:"
    if [ -f "$DIR/networks.conf" ]; then
        grep -c ';$' "$DIR/networks.conf" | xargs echo "  networks:"
        grep '^#   ' "$DIR/networks.conf" | sed 's/^#/ /'
        echo "  built: $(date -r "$DIR/networks.conf" '+%Y-%m-%d %H:%M')"
    else
        echo "  NOT BUILT"
    fi
    echo "enforcement:"
    if [ -f "$CONFD/00-baja-geoblock.conf" ] && grep -q 'return 403' "$DIR/enforce.conf" 2>/dev/null; then
        echo "  ON"
    elif [ -f "$CONFD/00-baja-geoblock.conf" ]; then
        echo "  installed but DISABLED"
    else
        echo "  not installed"
    fi
    echo "  server blocks carrying the include:"
    for f in $(configs); do grep -q "$MARKER" "$f" && echo "    $f"; done
    echo "exemptions:"
    # grep -c PRINTS the count and then exits 1 when that count is zero, and no
    # exemptions is the normal state. `|| echo 0` therefore appends a second zero
    # to the one grep already printed; `|| true` just swallows the exit status.
    # Letting it become the script's exit status made a healthy report read as a
    # failure to anything checking $?.
    echo "  addresses allowed through: $(grep -c '0;$' "$DIR/allow.conf" 2>/dev/null || true)"
    exit 0
    ;;

*)
    sed -n '2,20p' "$0"
    ;;
esac
