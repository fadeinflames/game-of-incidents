#!/bin/sh
# SECRET. Night shift of the security team: (1) the storage access key is rotated (vault + storage get version 2, the S3 gateway restarts with the new root key),
# (2) as part of the same change the sync ServiceAccount loses its vault read binding, so secret-sync fails and
# media-api keeps running with key version 1. Uploads fail with an access-key error; reads still come from the cache.
set -u

up() { # upload through a media-api pod; prints HTTP status
  kubectl -n media exec deploy/media-api -- python3 -c 'import urllib.request as u, urllib.error as e
req = u.Request("http://127.0.0.1:8080/upload/" + "'"$1"'", data=b"x" * 2048, method="POST")
try: print(u.urlopen(req, timeout=8).status)
except e.HTTPError as x: print(x.code)
except Exception: print(0)' 2>/dev/null | tr -d '\r'
}

# retry an upload until it is stored or the time is up; a deadline on the clock, because one try can take 8 s by itself
up_within() { # name seconds
  end=$(( $(date +%s) + $2 ))
  while :; do
    [ "$(up "$1")" = "201" ] && return 0
    [ "$(date +%s)" -ge "$end" ] && return 1
    sleep 2
  done
}

# a few files exist from before the rotation (they stay readable from the cache); the gateway must accept them.
# The first upload doubles as the wait for the gateway and media-api (the platform already waited for both to be Available)
up_within avatar-1042.png 60 || { echo "break: FAILED, pre-rotation upload of avatar-1042.png never succeeded" >&2; exit 1; }
for f in avatar-2210.png invoice-77.pdf; do
  up_within "$f" 10 || { echo "break: FAILED, pre-rotation upload of $f never succeeded" >&2; exit 1; }
done

new_ak="AKIAMEDIA2025PROD02"
new_sk="Zq8wE3rT6yU1iO4pA7sD0fG2hJ5kL9mN"
kubectl -n security create secret generic s3-credentials --from-literal=access_key="$new_ak" --from-literal=secret_key="$new_sk" --dry-run=client -o yaml | kubectl -n security apply -f - >/dev/null
kubectl -n security annotate secret s3-credentials security/key-version="2" security/rotated-at="$(date -u +%FT%TZ)" --overwrite >/dev/null
kubectl -n storage create secret generic storage-root --from-literal=access_key="$new_ak" --from-literal=secret_key="$new_sk" --dry-run=client -o yaml | kubectl -n storage apply -f - >/dev/null
kubectl -n storage rollout restart deploy/s3 >/dev/null
kubectl -n storage rollout status deploy/s3 --timeout=60s >/dev/null 2>&1 || true

# "vault policy tightened": the sync account can no longer read the vault
kubectl -n security delete rolebinding secret-sync-reader >/dev/null 2>&1 || true
kubectl -n media create job --from=cronjob/secret-sync secret-sync-29010200 >/dev/null 2>&1 || true

end=$(( $(date +%s) + 80 ))
while [ "$(date +%s)" -lt "$end" ]; do
  code=$(up probe-after-rotation.bin)
  failed=$(kubectl -n media get job secret-sync-29010200 -o jsonpath='{.status.failed}' 2>/dev/null)
  if [ "${code:-0}" = "500" ] && [ "${failed:-0}" -ge 1 ]; then echo "break: done (upload -> $code, secret-sync failed)"; exit 0; fi
  sleep 2
done
echo "break: FAILED (upload=${code:-?}, sync failed=${failed:-?})" >&2
exit 1
