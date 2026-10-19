#!/bin/sh
# secret-sync: the in-cluster stand-in for ExternalSecret. Copies the S3 credentials from the security namespace
# ("the vault") into the media namespace and bumps a rollout annotation so media-api picks the new keys up.
set -eu
echo "secret-sync: reading security/s3-credentials"
ak=$(kubectl -n security get secret s3-credentials -o jsonpath='{.data.access_key}' | base64 -d)
sk=$(kubectl -n security get secret s3-credentials -o jsonpath='{.data.secret_key}' | base64 -d)
ver=$(kubectl -n security get secret s3-credentials -o jsonpath='{.metadata.annotations.security/key-version}')
echo "secret-sync: vault has key version ${ver:-?} (${ak})"
kubectl -n media create secret generic media-s3 --from-literal=access_key="$ak" --from-literal=secret_key="$sk" \
  --dry-run=client -o yaml | kubectl -n media apply -f - >/dev/null
kubectl -n media annotate secret media-s3 security/key-version="${ver:-0}" --overwrite >/dev/null
kubectl -n media patch deploy media-api -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"security/key-version\":\"${ver:-0}\"}}}}}" >/dev/null
echo "secret-sync: media/media-s3 updated to version ${ver:-?}, media-api restarting"
