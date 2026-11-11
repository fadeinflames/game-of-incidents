#!/bin/sh
# SECRET reference solution: give the site files the extension the include lines expect, validate, reload.
# The file that ends with .disabled is off on purpose and stays as it is.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
cd /etc/nginx/sites

for f in regions/*.conf.new services/*.conf.new; do
  if [ -e "$f" ]; then mv "$f" "${f%.new}"; fi
done
for f in regions/*.cfg services/*.cfg; do
  if [ -e "$f" ]; then mv "$f" "${f%.cfg}.conf"; fi
done

nginx -t >/dev/null 2>&1 || { echo "solve: nginx -t fails after the renames" >&2; exit 1; }
service nginx reload >/dev/null 2>&1

i=0; a=000; b=000
while [ $i -lt 20 ]; do
  a=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: ufa.polka.example' http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  b=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: api.polka.example' http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  [ "$a" = "200" ] && [ "$b" = "200" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$a" = "200" ] && [ "$b" = "200" ] || { echo "solve: the sites still answer ufa $a, api $b" >&2; exit 1; }
# a reload is graceful: wait until the workers of the old configuration are gone
i=0
while pgrep -f 'nginx: worker process is shutting down' >/dev/null 2>&1 && [ $i -lt 20 ]; do i=$((i + 1)); sleep 0.5; done
echo "solve: done"
