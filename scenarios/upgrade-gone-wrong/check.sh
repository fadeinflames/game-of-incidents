#!/bin/sh
# SECRET grader: the bleeding is stopped (the controller cannot drain again: autoUpgrade off or the controller scaled to 0),
# both stateful systems are whole on their ORIGINAL disks, nothing is Pending, the controller itself was not deleted,
# and it stays that way for a minute. Result, not method: any way to pause is fine, relabelling nodes to fool the
# zonal PVs is not (the replicas would start on empty directories).
ok_pause=false; msg_pause="автоматика не остановлена: autoUpgrade=true и контроллер работает, он снова осушит ноду"
ok_ev=false;    msg_ev="events не в 3 из 3 Ready (under-replicated partitions)"
ok_st=false;    msg_st="store не в 3 из 3 Ready"
ok_pend=false;  msg_pend="в production есть поды в Pending"
ok_ctl=false;   msg_ctl="node-upgrade-controller удалён: обновления больше никогда не пройдут, это не решение"
ok_data=false;  msg_data="зоны и версии stateful-нод или привязки PVC изменены: реплики поднялись бы на пустых дисках, это потеря данных"
ok_stable=false; msg_stable="через минуту состояние снова ухудшилось (нода опять cordoned или поды не Ready)"

ready_of() { kubectl -n production get statefulset "$1" -o jsonpath='{.status.readyReplicas}' 2>/dev/null; }
pending_count() { kubectl -n production get pods --field-selector=status.phase=Pending -o name 2>/dev/null | wc -l; }
cordoned_count() { kubectl get nodes -l node-pool=stateful -o jsonpath='{range .items[?(@.spec.unschedulable==true)]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -c .; }

# 1. the controller cannot drain any more
auto=$(kubectl -n kube-system get configmap node-upgrade -o jsonpath='{.data.autoUpgrade}' 2>/dev/null)
ctl_replicas=$(kubectl -n kube-system get deploy node-upgrade-controller -o jsonpath='{.spec.replicas}' 2>/dev/null)
if [ "$auto" != "true" ]; then
  ok_pause=true; msg_pause="auto-upgrade поставлен на паузу (autoUpgrade=${auto:-unset})"
elif [ "$ctl_replicas" = "0" ]; then
  ok_pause=true; msg_pause="контроллер обновлений остановлен (replicas=0), новых drain не будет"
fi

# drain in flight may still evict a second replica for a few seconds after the pause + uncordon: wait for a stable 3/3
tries=12; $ok_pause || tries=1
i=0
while [ $i -lt $tries ]; do
  ev=$(ready_of events); st=$(ready_of store); pending=$(pending_count)
  [ "${ev:-0}" = "3" ] && [ "${st:-0}" = "3" ] && [ "$pending" -eq 0 ] && break
  i=$((i + 1)); [ $i -lt $tries ] && sleep 5
done

[ "${ev:-0}" = "3" ] && { ok_ev=true; msg_ev="events: 3 из 3 Ready, партиции реплицированы"; }
[ "${st:-0}" = "3" ] && { ok_st=true; msg_st="store: 3 из 3 Ready"; }
[ "$pending" -eq 0 ] && { ok_pend=true; msg_pend="Pending-подов нет"; }

if kubectl -n kube-system get deploy node-upgrade-controller >/dev/null 2>&1; then ok_ctl=true; msg_ctl="node-upgrade-controller на месте"; fi

# 2. the disks are still the original ones: the stateful nodes keep their zones/versions, the claims keep their volumes
topo=$(kubectl get nodes -l node-pool=stateful -o json 2>/dev/null | jq -r '.items[] | .metadata.labels | [.["topology.kubernetes.io/zone"], .["upgrade/kubelet-version"]] | join(" ")' | sort | tr '\n' ';')
pvcs=$(kubectl -n production get pvc -o json 2>/dev/null | jq -r '.items[] | "\(.metadata.name)=\(.spec.volumeName)"' | sort | tr '\n' ';')
want_topo="ru-central1-a v1.33.5;ru-central1-b v1.33.5;ru-central1-d v1.34.0;"
want_pvcs="data-events-0=events-disk-0;data-events-1=events-disk-1;data-events-2=events-disk-2;data-store-0=store-disk-0;data-store-1=store-disk-1;data-store-2=store-disk-2;"
if [ "$topo" = "$want_topo" ] && [ "$pvcs" = "$want_pvcs" ]; then ok_data=true; msg_data="диски на месте: зоны нод и привязки PVC не менялись"; fi

# 3. the controller ticks every 30 s: wait one tick and re-check
sleep 40
ev2=$(ready_of events); st2=$(ready_of store); pending2=$(pending_count); cord=$(cordoned_count)
if [ "${ev2:-0}" = "3" ] && [ "${st2:-0}" = "3" ] && [ "$pending2" -eq 0 ] && [ "$cord" -eq 0 ]; then ok_stable=true; msg_stable="состояние стабильно: ноды не cordoned, обе системы целы"; fi

passed=false
if $ok_pause && $ok_ev && $ok_st && $ok_pend && $ok_ctl && $ok_data && $ok_stable; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"upgrade-paused","ok":%s,"message":"%s"},' "$ok_pause" "$msg_pause"
printf '{"id":"events-whole","ok":%s,"message":"%s"},' "$ok_ev" "$msg_ev"
printf '{"id":"store-whole","ok":%s,"message":"%s"},' "$ok_st" "$msg_st"
printf '{"id":"nothing-pending","ok":%s,"message":"%s"},' "$ok_pend" "$msg_pend"
printf '{"id":"controller-kept","ok":%s,"message":"%s"},' "$ok_ctl" "$msg_ctl"
printf '{"id":"data-intact","ok":%s,"message":"%s"},' "$ok_data" "$msg_data"
printf '{"id":"stays-healthy","ok":%s,"message":"%s"}' "$ok_stable" "$msg_stable"
printf ']}\n'
