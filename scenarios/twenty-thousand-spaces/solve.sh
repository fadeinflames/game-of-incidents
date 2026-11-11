#!/bin/sh
# SECRET reference solution: trim lines without a backtracking regex, restart the forum, take the health check off the
# heaviest page.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# 1. the cause: a plain strip is linear whatever the line looks like
cat > /opt/forum/render.py <<'PY'
"""Post rendering: every line of a post is cleaned and escaped before it goes into a page."""
import html

# whitespace plus the zero-width non-joiners that some editors leave behind
_STRIP = " \t\r\n\x0b\x0c ‌"


def clean_line(line):
    return line.strip(_STRIP)


def render_post(body):
    return "<br>".join(html.escape(clean_line(line)) for line in body.split("\n"))
PY
service forum-web1 restart >/dev/null 2>&1
service forum-web2 restart >/dev/null 2>&1

# 2. the amplifier: the health check must not depend on the heaviest page
sed -i 's#^\( *option httpchk GET \)/$#\1/health#' /etc/haproxy/haproxy.cfg
grep -q 'option httpchk GET /health' /etc/haproxy/haproxy.cfg || { echo "solve: the health check was not changed" >&2; exit 1; }
service haproxy reload >/dev/null 2>&1

# two passed checks three seconds apart bring a server back
i=0; code=000
while [ $i -lt 40 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] || { echo "solve: the site still answers $code" >&2; exit 1; }
sleep 7
echo "solve: done"
