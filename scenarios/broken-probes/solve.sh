#!/bin/sh
# SECRET reference solution: point both probes at the new health path and let the rollout finish.
set -eu
kubectl patch deploy web --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/healthz"},
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/httpGet/path","value":"/healthz"}]' >/dev/null
kubectl rollout status deploy/web --timeout=120s >/dev/null
echo "solve: done"
