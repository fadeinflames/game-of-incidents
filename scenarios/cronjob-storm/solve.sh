#!/bin/sh
# SECRET reference solution: stop the generator, clear the backlog, make overlapping impossible, restore a sane schedule.
set -eu
kubectl -n batch patch cronjob nightly-export --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
kubectl -n batch delete jobs -l app=nightly-export --wait=false >/dev/null 2>&1 || true
kubectl -n batch patch cronjob nightly-export --type=merge -p '{"spec":{"concurrencyPolicy":"Forbid","schedule":"0 2 * * *","startingDeadlineSeconds":600}}' >/dev/null
i=0
while [ $i -lt 40 ]; do
  left=$(kubectl -n batch get pods -l app=nightly-export -o jsonpath='{range .items[*]}{.status.phase}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null | awk -F'|' '$1=="Running" && $2==""' | wc -l)
  [ "$left" -eq 0 ] && break
  i=$((i + 1)); sleep 2
done
kubectl -n batch patch cronjob nightly-export --type=merge -p '{"spec":{"suspend":false}}' >/dev/null
echo "solve: done"
