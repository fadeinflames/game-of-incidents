#!/bin/sh
# SECRET reference solution: reuse an entitlement for five minutes instead of two seconds (the longest the revocation
# rule allows) and apply the setting with a reload, which keeps the cache. The gateway and the clients are not touched.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
ENVFILE=/etc/catalog-api/catalog-api.env

sed -i 's/^ENTITLEMENT_CACHE_TTL_SEC=.*/ENTITLEMENT_CACHE_TTL_SEC=300/' "$ENVFILE"
grep -q '^ENTITLEMENT_CACHE_TTL_SEC=300$' "$ENVFILE" || { echo "solve: the setting was not changed" >&2; exit 1; }
service catalog-api reload >/dev/null 2>&1 </dev/null

# the process itself must report the new lifetime
i=0; ttl=""
while [ $i -lt 20 ]; do
  ttl=$(curl -q -s --max-time 3 http://127.0.0.1:8080/internal/config </dev/null 2>/dev/null | jq -r '.entitlement_cache_ttl_sec // empty' 2>/dev/null || true)
  [ "$ttl" = "300" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$ttl" = "300" ] || { echo "solve: catalog-api still reports a lifetime of ${ttl:-nothing}" >&2; exit 1; }
echo "solve: done"
