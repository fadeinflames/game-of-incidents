#!/bin/sh
# SECRET grader: the maintenance node is drained (cordoned, nothing but daemonsets on it), the database is whole,
# the app is whole, the PDB still protects the database the way it was agreed (one replica out at most), nothing is stuck Pending.
# The node is pinned by name (kind: the second worker is zone b / pool db, see workerLabels), not by the label the player may move.
# Once the node is empty, the pods that moved need a while to become Ready, so that case gets up to ~80 s of retries.

probe() {
  ok_drain=false; msg_drain="нода на обслуживании не осушена: на ней ещё есть поды или она раскордонена"
  ok_db=false;    msg_db="database не в 3 из 3 Ready"
  ok_app=false;   msg_app="app-backend не в 5 из 5 Ready"
  ok_pdb=false;   msg_pdb="PDB database-pdb удалён или не соответствует договорённости (одна реплика вне строя, не больше)"
  ok_pend=false;  msg_pend="в production есть поды в Pending"

  node=$(kubectl get nodes -o name 2>/dev/null | sed 's|^node/||' | grep -- '-worker2$' | head -1)
  [ -n "$node" ] || node=$(kubectl get nodes -l maintenance=kernel-update -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  cordoned=$(kubectl get node "$node" -o jsonpath='{.spec.unschedulable}' 2>/dev/null)
  # pods that are already terminating do not count: the eviction is done, the kubelet is just finishing
  onnode=$(kubectl get pods -A --field-selector=spec.nodeName="$node" --no-headers -o custom-columns=KIND:.metadata.ownerReferences[0].kind,DEL:.metadata.deletionTimestamp 2>/dev/null | awk '$2=="<none>" && $1!="DaemonSet"{n++} END{print n+0}')
  if [ -z "$node" ]; then msg_drain="не нашёл ноду на обслуживании"
  elif [ "$cordoned" != "true" ]; then msg_drain="$node раскордонена: обслуживание отменено, а не завершено"
  elif [ "${onnode:-1}" -ne 0 ]; then msg_drain="на $node ещё есть поды, кроме DaemonSet: $onnode"
  else ok_drain=true; msg_drain="$node осушена: cordoned, только DaemonSet-поды"; fi

  dbready=$(kubectl -n production get statefulset database -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${dbready:-0}" = "3" ] && { ok_db=true; msg_db="database: 3 из 3 Ready"; }

  appready=$(kubectl -n production get deploy app-backend -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${appready:-0}" = "5" ] && { ok_app=true; msg_app="app-backend: 5 из 5 Ready"; }

  # the budget is judged by what it allows with all three replicas healthy: that covers minAvailable 2, 66 %, maxUnavailable 1, 33 %
  if kubectl -n production get pdb database-pdb >/dev/null 2>&1; then
    allowed=$(kubectl -n production get pdb database-pdb -o jsonpath='{.status.disruptionsAllowed}' 2>/dev/null)
    expected=$(kubectl -n production get pdb database-pdb -o jsonpath='{.status.expectedPods}' 2>/dev/null)
    if [ "${dbready:-0}" != "3" ]; then msg_pdb="бюджет считается по здоровым подам: дождись 3 из 3 Ready у database и проверь снова"
    elif [ "$expected" != "3" ]; then msg_pdb="PDB database-pdb не охватывает три реплики базы"
    elif [ "$allowed" = "1" ]; then ok_pdb=true; msg_pdb="PDB database-pdb: вне строя может быть ровно одна реплика"
    elif [ "$allowed" = "0" ]; then msg_pdb="PDB database-pdb не допускает ни одной недоступной реплики: следующий drain снова встанет"
    else msg_pdb="PDB database-pdb допускает недоступными $allowed реплики из 3: договорённость — не больше одной"; fi
  fi

  pending=$(kubectl -n production get pods --field-selector=status.phase=Pending -o name 2>/dev/null | wc -l)
  [ "$pending" -eq 0 ] && { ok_pend=true; msg_pend="Pending-подов нет"; }
}

deadline=$(( $(date +%s) + 80 ))
while :; do
  probe
  if $ok_drain && $ok_db && $ok_app && $ok_pdb && $ok_pend; then break; fi
  # a node that is not drained is the player's next command, not something that settles by itself
  $ok_drain || break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 5
done

passed=false
if $ok_drain && $ok_db && $ok_app && $ok_pdb && $ok_pend; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"node-drained","ok":%s,"message":"%s"},' "$ok_drain" "$msg_drain"
printf '{"id":"database-whole","ok":%s,"message":"%s"},' "$ok_db" "$msg_db"
printf '{"id":"app-whole","ok":%s,"message":"%s"},' "$ok_app" "$msg_app"
printf '{"id":"pdb-sane","ok":%s,"message":"%s"},' "$ok_pdb" "$msg_pdb"
printf '{"id":"nothing-pending","ok":%s,"message":"%s"}' "$ok_pend" "$msg_pend"
printf ']}\n'
