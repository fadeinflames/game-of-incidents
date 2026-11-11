#!/bin/sh
# SECRET. Stage 1 of the access change lands on analytics node n1: the service accounts get explicit grants on the shard
# tables. The feature query has no schema filter, so on n1 it now sees request_features twice (dist and shard0) and returns
# 240 features. The worker's table holds 200: it dies on that file and comes back when the next cycle reads node n2.
set -u
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
FEATURES=/var/lib/edge/features/current.json

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

count() {
  python3 -c 'import json,sys
try:
    print(len(json.load(open(sys.argv[1]))["features"]))
except Exception:
    print(0)' "$FEATURES" </dev/null 2>/dev/null
}

# the stand must be healthy before it is broken: a good file and a serving edge
i=0
while [ $i -lt 40 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  [ "$code" = "200" ] && [ "$(count)" = "120" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] || { echo "break: FAILED, the edge did not come up healthy (HTTP $code, $(count) features)" >&2; exit 1; }

# the plan of the access change: node n1 now, node n2 in seven minutes
plan=/var/lib/access-rollout/state.json
printf '{"ticket":"SEC-2291","started_at":%s,"stages":[{"node":"n1","after_sec":0},{"node":"n2","after_sec":420}]}\n' "$(date +%s)" > "$plan.tmp"
chown postgres:postgres "$plan.tmp" && mv "$plan.tmp" "$plan"

q="SELECT has_table_privilege('featuregen', 'shard0.request_features', 'SELECT')"
i=0; got=f
while [ $i -lt 30 ]; do
  got=$(su postgres -c "psql -X -q -tA -d analytics_n1 -c \"$q\"" </dev/null 2>/dev/null)
  [ "$got" = "t" ] && break
  i=$((i + 1)); sleep 1
done
[ "$got" = "t" ] || { echo "break: FAILED, the access change was not applied to node n1" >&2; exit 1; }

# wait until the generator has read node n1 once and the edge has answered 502 at least once
i=0; seen=0
while [ $i -lt 60 ]; do
  n=$(count)
  if [ "${n:-0}" -gt 200 ]; then seen=$n; break; fi
  i=$((i + 1)); sleep 1
done
[ "$seen" -gt 200 ] || { echo "break: FAILED, the generator did not produce an oversized file in 60 s" >&2; exit 1; }
i=0; code=000
while [ $i -lt 20 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  [ "$code" = "502" ] && break
  i=$((i + 1)); sleep 0.5
done
[ "$code" = "502" ] || { echo "break: FAILED, the edge still answers $code after an oversized file" >&2; exit 1; }
echo "break: done (features file with $seen entries, edge answers 502 in waves)"
