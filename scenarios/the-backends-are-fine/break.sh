#!/bin/sh
# SECRET. The editor plugin 2.9.0 reaches 50 of the 60 plugin accounts. It refreshes the engine list every 2 seconds, and
# catalog-api reuses an entitlement for 2 seconds only, so nearly every refresh becomes a lookup in the entitlements
# service. In a rush that is about 25 lookups per second against a gateway limit of 5: the gateway answers 429 and
# catalog-api turns that into "Engines are temporarily unavailable".
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 180 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 90 s" >&2; exit 1; }

list() {
  curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'X-Account: acc-1064' -A 'translator-cli/1.4.1' \
    http://127.0.0.1/v1/engines </dev/null 2>/dev/null || echo 000
}
errors() {
  curl -q -s --max-time 3 http://127.0.0.1:8080/internal/stats </dev/null 2>/dev/null | jq -r '.list_errors // empty' 2>/dev/null
}

# the stand must be healthy before it is broken: the list is served and nobody has seen an error yet
i=0; code=000
while [ $i -lt 40 ]; do
  code=$(list)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] || { echo "break: FAILED, the engine list was not served before the break (HTTP $code)" >&2; exit 1; }
before=$(errors)
[ "$before" = "0" ] || { echo "break: FAILED, the stand already had list errors before the break (${before:-no answer})" >&2; exit 1; }

# the rollout: 50 plugin accounts now run 2.9.0
echo '{"plugin_2_9_accounts": 50}' > /var/lib/loadgen/fleet.json
service loadgen restart >/dev/null 2>&1 </dev/null

# the first rush starts five seconds after the users are back; wait until it has produced errors
i=0; now=0
while [ $i -lt 90 ]; do
  now=$(errors)
  case "$now" in ''|*[!0-9]*) now=0 ;; esac
  [ "$now" -ge 30 ] && break
  i=$((i + 1)); sleep 1
done
[ "$now" -ge 30 ] || { echo "break: FAILED, the rush did not produce list errors in 90 s (list_errors=$now)" >&2; exit 1; }
echo "break: done (plugin 2.9.0 is out, the engine list fails in every rush)"
