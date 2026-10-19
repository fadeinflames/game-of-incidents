#!/bin/sh
# SECRET reference solution: restore the sync account's read access to the vault, run the sync by hand
# (it updates media-s3 and restarts media-api), wait for the rollout.
set -eu
kubectl -n security create rolebinding secret-sync-reader --role=secret-reader --serviceaccount=media:secret-sync >/dev/null
kubectl -n media create job --from=cronjob/secret-sync secret-sync-manual-1 >/dev/null
kubectl -n media wait --for=condition=complete job/secret-sync-manual-1 --timeout=120s >/dev/null
kubectl -n media rollout status deploy/media-api --timeout=120s >/dev/null
echo "solve: done"
