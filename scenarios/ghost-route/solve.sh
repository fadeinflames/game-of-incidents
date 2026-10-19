#!/bin/sh
# SECRET reference solution: keep catalog v2's SPA routing on shop.local, drop the api.shop.local rule from it.
set -eu
kubectl patch ingress catalog-v2 --type=json -p='[{"op":"remove","path":"/spec/rules/1"}]' >/dev/null
sleep 75
echo "solve: done"
