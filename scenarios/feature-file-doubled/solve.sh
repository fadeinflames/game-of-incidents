#!/bin/sh
# SECRET reference solution: stop the generator, give the worker the last good file, fix the query, start the generator.
set -eu
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DIR=/var/lib/edge/features

# 1. mitigation: no new bad files, and the newest archived file that fits the worker's table goes back in place
service featuregen stop >/dev/null 2>&1 || true
good=$(python3 -c 'import json,os,sys
d = sys.argv[1]
for name in sorted(os.listdir(d), reverse=True):
    try:
        f = json.load(open(os.path.join(d, name)))["features"]
    except Exception:
        continue
    if 0 < len(f) <= 200 and len({x["name"] for x in f}) == len(f):
        print(os.path.join(d, name))
        break' "$DIR/archive" </dev/null)
[ -n "$good" ] || { echo "solve: no good features file in the archive" >&2; exit 1; }
cp "$good" "$DIR/current.json.tmp" && chown edge:edge "$DIR/current.json.tmp" && mv "$DIR/current.json.tmp" "$DIR/current.json"

# 2. root cause: the query must name the schema, then the extra grants no longer change its result
sed -i "s/^WHERE table_name = 'request_features'/WHERE table_schema = 'dist' AND table_name = 'request_features'/" /etc/featuregen/query.sql
grep -q "table_schema = 'dist'" /etc/featuregen/query.sql || { echo "solve: the query was not changed" >&2; exit 1; }

# 3. the generator is back; its first cycle reads node n1, the one with the new grants
service featuregen start >/dev/null 2>&1
i=0; code=000
while [ $i -lt 40 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] || { echo "solve: the edge still answers $code" >&2; exit 1; }
sleep 3
echo "solve: done"
