#!/bin/sh
# SECRET grader: partner and cluster names resolve, the app's resolution success is back, CoreDNS is still restricted
# by a NetworkPolicy (with a proper egress rule), CoreDNS is healthy.
ok_corp=false;  msg_corp="payments-gateway.corp.internal не резолвится из пода приложения"
ok_clu=false;   msg_clu="имена кластера (backend-api.shop.svc.cluster.local) не резолвятся"
ok_rate=false;  msg_rate="приложение всё ещё получает ошибки резолва (success rate за минуту ниже 95 %)"
ok_pol=false;   msg_pol="NetworkPolicy для CoreDNS удалена или без правил egress: security требует ограничить CoreDNS, а не снять ограничения"
ok_dns=false;   msg_dns="coredns не в 2 из 2 Ready"

res=$(kubectl -n shop exec deploy/external-api-proxy -- python3 -c 'import socket
def r(n):
    try: socket.getaddrinfo(n, 443); return 1
    except OSError: return 0
print(r("payments-gateway.corp.internal"), r("backend-api.shop.svc.cluster.local"))' 2>/dev/null | tr -d '\r')
[ "${res%% *}" = "1" ] && { ok_corp=true; msg_corp="payments-gateway.corp.internal резолвится"; }
[ "${res##* }" = "1" ] && { ok_clu=true; msg_clu="имена кластера резолвятся"; }

rate=$(kubectl -n shop exec deploy/external-api-proxy -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); v=d["payments-gateway.corp.internal"]["success_rate"]; print(v if v is not None else -1)' 2>/dev/null | tr -d '\r')
pct=$(printf '%s' "${rate:--1}" | awk '{printf "%d", $1*100}')
[ "$pct" -ge 95 ] && { ok_rate=true; msg_rate="резолв партнёрского имени за минуту: $pct %"; }

# every policy that selects the CoreDNS pods counts together (NetworkPolicies add up); an egress rule must be an explicit
# allowance: not "everything", with DNS to the upstream and the API server among the ports
pols=$(kubectl -n kube-system get networkpolicy -o json 2>/dev/null)
verdict=$(printf '%s' "$pols" | jq -r '
  def selects: (.spec.podSelector.matchLabels // {}) as $ml | (.spec.podSelector.matchExpressions // []) as $me
    | ([$ml | keys[] | select(. != "k8s-app")] | length) == 0
    and (($ml["k8s-app"] == "kube-dns" and ($me | length) == 0)
      or (($ml | length) == 0 and ($me | length) == 1 and $me[0].key == "k8s-app" and $me[0].operator == "In" and ($me[0].values // []) == ["kube-dns"]));
  def open_egress: ((.ports // []) | length) == 0
    and (((.to // []) | length) == 0 or any((.to // [])[]; . == {} or (.ipBlock.cidr // "") == "0.0.0.0/0" or (.ipBlock.cidr // "") == "::/0"));
  [.items[] | select(selects)] as $p
  | [$p[] | select((.spec.policyTypes // []) | index("Egress")) | (.spec.egress // [])[]] as $eg
  | [$p[] | select((.spec.policyTypes // []) | index("Ingress")) | (.spec.ingress // [])[]] as $in
  | if ($p | length) == 0 then "none"
    elif ($eg | length) == 0 then "no-egress"
    elif any($eg[]; open_egress) then "open-egress"
    elif (any($eg[] | (.ports // [])[]; ((.protocol // "TCP") == "UDP") and ((.port | tostring) == "53")) | not) then "no-dns"
    elif (any($eg[] | (.ports // [])[]; ((.protocol // "TCP") == "TCP") and (((.port | tostring) == "443") or ((.port | tostring) == "6443"))) | not) then "no-api"
    elif ($in | length) == 0 then "no-ingress"
    else "ok" end' 2>/dev/null)
case "$verdict" in
  ok)          ok_pol=true; msg_pol="CoreDNS ограничен NetworkPolicy: ingress 53, egress разрешён явными правилами" ;;
  none)        msg_pol="NetworkPolicy для CoreDNS нет: security требует ограничить CoreDNS, а не снять ограничения" ;;
  no-egress)   msg_pol="политика CoreDNS не разрешает исходящий трафик: нужны явные правила egress" ;;
  open-egress) msg_pol="в egress политики CoreDNS есть правило без ограничений: разрешай конкретные порты, а не всё подряд" ;;
  no-dns)      msg_pol="egress политики CoreDNS не разрешает DNS к upstream: нужен порт 53/UDP" ;;
  no-api)      msg_pol="egress политики CoreDNS не разрешает доступ к API-серверу (443 или 6443/TCP): плагин kubernetes перестанет обновляться" ;;
  no-ingress)  msg_pol="ingress для CoreDNS в политике не описан: он должен оставаться ограниченным портом 53" ;;
esac

dready=$(kubectl -n kube-system get deploy coredns -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${dready:-0}" = "2" ] && { ok_dns=true; msg_dns="coredns: 2 из 2 Ready"; }

passed=false
if $ok_corp && $ok_clu && $ok_rate && $ok_pol && $ok_dns; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"corp-names-resolve","ok":%s,"message":"%s"},' "$ok_corp" "$msg_corp"
printf '{"id":"cluster-names-resolve","ok":%s,"message":"%s"},' "$ok_clu" "$msg_clu"
printf '{"id":"app-resolution-rate","ok":%s,"message":"%s"},' "$ok_rate" "$msg_rate"
printf '{"id":"coredns-still-restricted","ok":%s,"message":"%s"},' "$ok_pol" "$msg_pol"
printf '{"id":"coredns-ready","ok":%s,"message":"%s"}' "$ok_dns" "$msg_dns"
printf ']}\n'
