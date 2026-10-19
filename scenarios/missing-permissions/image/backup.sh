#!/bin/sh
# db-backup job: 1) fetch the DB password from the credentials Secret (in-cluster analog of "decrypt with KMS"),
# 2) dump the database, 3) upload the snapshot to the backup store. Runs with the backup-controller ServiceAccount.
set -eu
echo "backup: starting $(date -u +%FT%TZ)"
echo "backup: fetching credentials data/db-credentials"
# capture and decode separately: in a pipeline the status of kubectl is lost and a Forbidden would surface later as a 401 from the database
pw_b64=$(kubectl -n data get secret db-credentials -o jsonpath='{.data.password}') || { echo "backup: FATAL cannot read credentials (permission denied)"; exit 1; }
pw=$(printf '%s' "$pw_b64" | base64 -d)
name="orders-$(date -u +%Y%m%d-%H%M).sql"
echo "backup: dumping database -> $name"
python3 - "$pw" "$name" <<'PY'
import sys, urllib.request, urllib.error
pw, name = sys.argv[1], sys.argv[2]
req = urllib.request.Request("http://database.data.svc:5432/dump", method="POST", headers={"X-Db-Password": pw})
try:
    dump = urllib.request.urlopen(req, timeout=20).read()
except urllib.error.HTTPError as e:
    print(f"backup: FATAL dump failed: HTTP {e.code} {e.read().decode().strip()}"); sys.exit(1)
put = urllib.request.Request(f"http://backup-store.backup.svc:8080/snapshots/{name}", data=dump, method="PUT")
r = urllib.request.urlopen(put, timeout=20)
print(f"backup: uploaded {name} ({len(dump)} bytes), store answered {r.status}")
PY
echo "backup: done"
