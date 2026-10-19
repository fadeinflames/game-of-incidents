#!/bin/sh
# SECRET reference solution: bring the spare zone-b node into the db pool, fix the PDB to what was agreed (2 of 3),
# then let the drain finish; database-1 lands on the spare node where its zonal disk is reachable.
set -eu
node=$(kubectl get nodes -l maintenance=kernel-update -o jsonpath='{.items[0].metadata.name}')
spare=$(kubectl get nodes -l topology.kubernetes.io/zone=ru-central1-b,node-pool=spare -o jsonpath='{.items[0].metadata.name}')
kubectl label node "$spare" node-pool=db --overwrite >/dev/null
kubectl -n production patch pdb database-pdb --type=merge -p '{"spec":{"minAvailable":2}}' >/dev/null
kubectl drain "$node" --ignore-daemonsets --delete-emptydir-data --timeout=180s >/dev/null
kubectl -n production rollout status statefulset/database --timeout=180s >/dev/null
kubectl -n production rollout status deploy/app-backend --timeout=120s >/dev/null
echo "solve: done"
