#!/bin/sh
# SECRET. Runs as root via stdin exec after the container starts (ADR-0004).
# Break: point the nginx upstream at a port where nothing listens.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
sed -i 's/127\.0\.0\.1:8081/127.0.0.1:8082/' /etc/nginx/sites-available/default
# make the "night deploy" story visible in logs without spelling out the fix
{
  echo "2024-06-11T03:10:02Z deploy: app v2.3.1 rolled out on web-01"
  echo "2024-06-11T03:10:05Z deploy: post-deploy config sync applied (nginx)"
  echo "2024-06-11T03:10:06Z deploy: status=success"
} >> /var/log/deploy.log
service nginx reload >/dev/null 2>&1 || service nginx restart >/dev/null 2>&1
# graceful reload keeps old workers (old config) alive for a moment: wait until the break is really live,
# then generate a few 502s so error.log has evidence for the player
i=0
while [ $i -lt 20 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1/ || echo 000)
  [ "$code" = "502" ] && break
  i=$((i + 1)); sleep 0.5
done
for n in 1 2 3; do curl -s -o /dev/null --max-time 2 http://127.0.0.1/ || true; done
[ "$code" = "502" ] || { echo "break: FAILED, last code $code" >&2; exit 1; }
echo "break: done"
