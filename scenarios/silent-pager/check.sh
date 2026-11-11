#!/bin/sh
# SECRET grader. Result, not method:
#   - the shoppers are served and the alert path delivers;
#   - the pods of the cluster DNS have been running without a restart for 90 s and survive a burst of 50 simultaneous
#     page loads sent by the grader (the same kind of load that a crowd of retrying shoppers gives);
#   - names of the cluster and of the downstream services resolve from the aggregator pods;
#   - the constraints of the brief hold (memory limit kept and sane, names are still names, clients untouched,
#     the datacenter resolver untouched, no bypass of the cluster DNS).
# Side effect on purpose: on a stand that only looks healthy the burst brings the failure back.
tmp=$(mktemp -d /tmp/wom-check.XXXXXX) || exit 1
trap 'rm -rf "$tmp"' EXIT

ok_store=false;  msg_store="за последнюю минуту обслужено меньше 95 % покупателей"
ok_names=false;  msg_names="aggregator не может обратиться к части сервисов по именам"
ok_sys=false;    msg_sys="в kube-system есть поды не в Ready или с перезапусками за последние 90 секунд"
ok_burst=false;  msg_burst="проверка всплеском не запускалась: сначала должны пройти проверки имён, системных подов и ограничений"
ok_alert=false;  msg_alert="провайдер оповещений не получает heartbeat от мониторинга кластера"
ok_rules=false;  msg_rules="не удалось проверить ограничения из брифа"

dns_state() {
  kubectl -n kube-system get pods -l k8s-app=kube-dns -o json 2>/dev/null | jq -c --argjson now "$(date +%s)" '
    [.items[] | select(.metadata.deletionTimestamp == null)] as $p
    | { n: ($p | length),
        ready: ([$p[] | select(.status.phase == "Running" and ((.status.containerStatuses // []) | (length > 0 and all(.[]; .ready))))] | length),
        minage: ([$p[] | (.status.containerStatuses // [])[] | if .state.running.startedAt then ($now - (.state.running.startedAt | fromdateiso8601)) else -1 end] | min // -1),
        restarts: ([$p[] | (.status.containerStatuses // [])[] | .restartCount] | add // 0),
        uids: ([$p[] | .metadata.uid] | sort | join(",")) }' 2>/dev/null
}

# ---- cluster DNS pods: all ready, no restart in the last 90 s
before=$(dns_state)
n=$(printf '%s' "$before" | jq -r '.n // 0' 2>/dev/null); n=${n:-0}
ready=$(printf '%s' "$before" | jq -r '.ready // 0' 2>/dev/null); ready=${ready:-0}
minage=$(printf '%s' "$before" | jq -r '.minage // -1' 2>/dev/null); minage=${minage:--1}
want=$(kubectl -n kube-system get deploy coredns -o jsonpath='{.spec.replicas}' 2>/dev/null); want=${want:-0}
if [ "$n" -ge 1 ] && [ "$ready" = "$n" ] && [ "$n" -ge "$want" ]; then
  if [ "$minage" -ge 90 ]; then ok_sys=true; msg_sys="системные поды в Ready и работают без перезапусков дольше 90 секунд"
  else msg_sys="системные поды в Ready, но последний запуск контейнера был $minage с назад: нужно 90 секунд без перезапусков"; fi
fi

# ---- constraints, part 1: what the API says
rules=""
v=$(kubectl -n kube-system get pods -l k8s-app=kube-dns -o json 2>/dev/null | jq -r '
  def mi: if . == null then null
    elif test("^[0-9.]+Ki$") then (.[:-2] | tonumber) / 1024
    elif test("^[0-9.]+Mi$") then (.[:-2] | tonumber)
    elif test("^[0-9.]+Gi$") then (.[:-2] | tonumber) * 1024
    elif test("^[0-9.]+k$") then (.[:-1] | tonumber) / 1048.576
    elif test("^[0-9.]+M$") then (.[:-1] | tonumber) / 1.048576
    elif test("^[0-9.]+G$") then (.[:-1] | tonumber) * 953.674
    elif test("^[0-9]+$") then tonumber / 1048576
    else 1000000 end;
  [.items[] | select(.metadata.deletionTimestamp == null) | .spec.containers[]] as $c
  | if ($c | length) == 0 then "none"
    elif any($c[]; ((.image // "") | startswith("registry.k8s.io/coredns/coredns")) | not) then "image"
    elif any($c[]; .resources.limits.memory == null) then "nolimit"
    elif any($c[]; (.resources.limits.memory | mi) > 256) then "toobig"
    else "ok" end' 2>/dev/null)
case "$v" in
  ok) ;;
  nolimit) rules="у контейнеров DNS кластера нет лимита памяти: по условию лимит должен остаться" ;;
  toobig)  rules="лимит памяти у подов DNS кластера больше 256Mi на под: на ноде 2 ГБ, и на ней же control plane" ;;
  image)   rules="DNS кластера должен остаться на CoreDNS из штатного образа" ;;
  *)       rules="у сервиса kube-dns нет подов" ;;
esac
if [ -z "$rules" ]; then
  svc=$(kubectl -n kube-system get svc kube-dns -o json 2>/dev/null | jq -r '.spec.clusterIP + " " + ((.spec.selector // {}) | to_entries | map(.key + "=" + .value) | sort | join(","))' 2>/dev/null)
  [ "$svc" = "10.96.0.10 k8s-app=kube-dns" ] || rules="сервис kube-dns изменён: поды должны резолвить имена через DNS кластера"
fi
agg=$(kubectl -n store get pods -l app=aggregator -o json 2>/dev/null | jq -r '
  [.items[] | select(.metadata.deletionTimestamp == null)] as $p
  | [$p[] | select(.status.phase == "Running" and ((.status.containerStatuses // []) | (length > 0 and all(.[]; .ready))))] as $r
  | (if ($r | length) < 2 then "few"
     elif any($p[]; ((.spec.hostAliases // []) | length) > 0) then "hostaliases"
     elif any($p[]; .spec.hostNetwork == true) then "hostnetwork"
     elif any($p[]; ([.spec.containers[] | select(.image == "wom-scenario/silent-pager:dev" and .command == null and .args == null and ((.env // []) | any(.name == "ROLE" and .value == "aggregator")))] | length) != 1) then "spec"
     else "ok" end), ($r[] | .metadata.name)' 2>/dev/null)
agg_verdict=$(printf '%s\n' "$agg" | head -n 1)
agg_pods=$(printf '%s\n' "$agg" | tail -n +2)
if [ -z "$rules" ]; then
  case "$agg_verdict" in
    ok) ;;
    few)         rules="у aggregator меньше двух подов в Ready" ;;
    hostaliases) rules="у подов aggregator заданы hostAliases: адреса сервисов должны приходить из DNS" ;;
    hostnetwork) rules="поды aggregator переведены в сеть ноды" ;;
    *)           rules="aggregator должен работать из своего образа со своей ролью" ;;
  esac
fi
if [ -z "$rules" ]; then
  v=$(kubectl -n store get deploy shoppers -o json 2>/dev/null | jq -r '
    (.spec.template.spec.containers // []) as $c
    | if (.status.readyReplicas // 0) < 1 then "down"
      elif ($c | length) != 1 or $c[0].image != "wom-scenario/silent-pager:dev" or $c[0].command != null or $c[0].args != null then "spec"
      elif (($c[0].env // []) | map({key: .name, value: .value}) | from_entries) != {"ROLE": "shoppers", "TARGET_URL": "http://10.96.30.10/page", "SHOPPERS_PER_SEC": "1", "RETRY_AFTER_MS": "3000", "PATIENCE_SEC": "60"} then "env"
      else "ok" end' 2>/dev/null)
  case "$v" in
    ok) ;;
    down) rules="shoppers остановлен: покупатели никуда не деваются, отключать их нельзя" ;;
    *)    rules="shoppers изменён: поведение покупателей менять нельзя" ;;
  esac
fi

# ---- inside every aggregator pod: resolution, effective downstream list, the datacenter resolver as it was
probe='
import json, socket, struct, threading, urllib.request
out = {"ns": [], "names": {}, "dead": None, "live": None, "urls": {}, "role": None}
for line in open("/etc/resolv.conf"):
    p = line.split()
    if len(p) > 1 and p[0] == "nameserver":
        out["ns"].append(p[1])
def res(name):
    try:
        socket.getaddrinfo(name, 80, 0, socket.SOCK_STREAM)
        out["names"][name] = True
    except OSError:
        out["names"][name] = False
def raw(key, name):
    q = struct.pack("!HHHHHH", 4242, 0x0100, 1, 0, 0, 0)
    q += b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + bytes(1) + struct.pack("!HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(1.2)
    try:
        s.sendto(q, ("10.96.0.53", 53))
        d = s.recv(512)
        out[key] = socket.inet_ntoa(d[-4:]) if d[3] & 15 == 0 and d[7] else "rcode%d" % (d[3] & 15)
    except OSError:
        out[key] = "timeout"
ts = [threading.Thread(target=res, args=(n,)) for n in ("kubernetes.default.svc.cluster.local.", "prices.int.shopnet.example")]
ts += [threading.Thread(target=raw, args=("dead", "wom-check.dc1.corp.example")), threading.Thread(target=raw, args=("live", "prices.int.shopnet.example"))]
for t in ts:
    t.start()
for t in ts:
    t.join(9)
try:
    st = json.load(urllib.request.urlopen("http://127.0.0.1:8080/stats", timeout=3))
    out["urls"] = {k: v["url"] for k, v in st["downstreams"].items()}
    out["role"] = st.get("role")
except Exception:
    pass
print(json.dumps(out))
'
for p in $agg_pods; do
  kubectl -n store exec "$p" -c aggregator -- python3 -c "$probe" </dev/null >"$tmp/probe.$p" 2>/dev/null &
done
wait
probes=0; bad_names=""; pods_names_ok=0
for p in $agg_pods; do
  probes=$((probes + 1))
  f="$tmp/probe.$p"
  miss=$(jq -r '[.names | to_entries[] | select(.value != true) | .key] | join(", ")' "$f" 2>/dev/null)
  cnt=$(jq -r '.names | length' "$f" 2>/dev/null)
  if [ "${cnt:-0}" = "2" ] && [ -z "$miss" ]; then pods_names_ok=$((pods_names_ok + 1)); else bad_names=${miss:-"нет ответа от пода"}; fi
  [ -n "$rules" ] && continue
  v=$(jq -r '
    def host: sub("^http://"; "") | sub("/.*$"; "") | sub(":80$"; "") | sub("[.]$"; "");
    .urls as $u
    | if .role != "aggregator" then "role"
      elif (.ns | index("10.96.0.53")) != null then "bypass"
      elif .dead != "timeout" or .live != "10.96.20.10" then "resolver"
      elif ($u | length) != 9 then "urls"
      elif any(("prices", "stock", "reviews", "recs", "banners", "delivery", "sizes", "brands"); . as $n | (($u[$n] // "") | host) != ($n + ".int.shopnet.example")) then "urls"
      elif (["sessions", "sessions.store", "sessions.store.svc", "sessions.store.svc.cluster.local"] | index(($u.sessions // "") | host)) == null then "urls"
      else "ok" end' "$f" 2>/dev/null)
  case "$v" in
    ok) ;;
    bypass)   rules="поды aggregator ходят в dc-resolver напрямую: имена должны резолвиться через DNS кластера" ;;
    resolver) rules="dc-resolver изменён: он принадлежит сетевой команде, менять его нельзя" ;;
    urls)     rules="список нижестоящих сервисов aggregator изменён: это должны быть те же девять сервисов по тем же именам, не IP-адреса" ;;
    *)        rules="aggregator должен работать из своего образа со своей ролью" ;;
  esac
done
if [ "$probes" -ge 2 ] && [ "$pods_names_ok" = "$probes" ]; then
  ok_names=true; msg_names="имена кластера и нижестоящих сервисов резолвятся из подов aggregator"
elif [ -n "$bad_names" ]; then
  msg_names="aggregator не может обратиться к части сервисов по именам ($bad_names)"
fi
if [ -z "$rules" ]; then ok_rules=true; msg_rules="ограничения из брифа соблюдены"; else msg_rules=$rules; fi

# ---- the burst: 50 pages at once through the public address of the store, then look at the cluster DNS again
if $ok_sys && $ok_names && $ok_rules; then
  token="wom$$x$(date +%s)"
  burst='
import asyncio, sys
async def one():
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection("10.96.30.10", 80), 4)
        w.write(("GET /page?probe=" + sys.argv[1] + " HTTP/1.1\r\nHost: store\r\nConnection: close\r\n\r\n").encode())
        d = await asyncio.wait_for(r.read(-1), 10)
        w.close()
        return d.startswith(b"HTTP/1.1 200")
    except Exception:
        return False
async def main():
    print(sum(await asyncio.gather(*[one() for _ in range(50)])))
asyncio.run(main())
'
  got=$(kubectl -n store exec deploy/shoppers -- python3 -c "$burst" "$token" </dev/null 2>/dev/null | tr -d '\r')
  got=${got:-0}
  sleep 8
  after=$(dns_state)
  seen=$(kubectl -n outside exec deploy/backends -- curl -q -s -m 4 "http://127.0.0.1:8080/admin/seen?probe=$token" </dev/null 2>/dev/null | jq -r '.services | length' 2>/dev/null)
  seen_s=$(kubectl -n store exec deploy/sessions -- curl -q -s -m 4 "http://127.0.0.1:8080/admin/seen?probe=$token" </dev/null 2>/dev/null | jq -r '.services | length' 2>/dev/null)
  same=$(jq -n --argjson a "${before:-null}" --argjson b "${after:-null}" 'if $a != null and $b != null and $a.uids == $b.uids and $a.restarts == $b.restarts and $b.ready == $b.n then 1 else 0 end' 2>/dev/null)
  if [ "${same:-0}" != "1" ]; then
    msg_burst="после всплеска из 50 одновременных запросов страницы системные поды перезапустились: обслужено $got из 50"
  elif [ "$got" -lt 47 ]; then
    msg_burst="всплеск из 50 одновременных запросов страницы: обслужено только $got"
  elif [ "${seen:-0}" != "8" ] || [ "${seen_s:-0}" != "1" ]; then
    msg_burst="страницы отдаются, но запросы не дошли до всех нижестоящих сервисов"
  else
    ok_burst=true; msg_burst="всплеск из 50 одновременных запросов страницы обслужен ($got из 50), системные поды не перезапускались"
  fi
fi

# ---- shoppers of the last minute
st=$(kubectl -n store exec deploy/shoppers -- curl -q -s -m 4 http://127.0.0.1:9090/stats </dev/null 2>/dev/null)
served=$(printf '%s' "$st" | jq -r '.shoppers_60s.served // 0' 2>/dev/null); served=${served:-0}
gave=$(printf '%s' "$st" | jq -r '.shoppers_60s.gave_up // 0' 2>/dev/null); gave=${gave:-0}
total=$((served + gave))
if [ "$total" -gt 0 ]; then
  pctv=$((served * 100 / total))
  if [ "$served" -ge 35 ] && [ $((served * 100)) -ge $((total * 95)) ]; then ok_store=true; msg_store="за последнюю минуту обслужено $pctv % покупателей ($served из $total)"
  elif [ "$served" -lt 35 ] && [ "$pctv" -ge 95 ]; then msg_store="за последнюю минуту обслужено только $served покупателей: окно ещё не заполнилось или покупатели не доходят до магазина"
  else msg_store="за последнюю минуту обслужено $pctv % покупателей ($served из $total), нужно не меньше 95 %"; fi
fi

# ---- the alert path
age=$(kubectl -n outside exec deploy/pager -- curl -q -s -m 4 http://127.0.0.1:8080/stats </dev/null 2>/dev/null | jq -r '.last_heartbeat_age_sec // -1' 2>/dev/null); age=${age:--1}
if [ "$age" -ge 0 ] && [ "$age" -le 40 ]; then ok_alert=true; msg_alert="провайдер оповещений получает heartbeat от мониторинга кластера (последний $age с назад)"
elif [ "$age" -gt 40 ]; then msg_alert="провайдер оповещений не получал heartbeat от мониторинга кластера $age с"; fi

passed=false
if $ok_store && $ok_names && $ok_sys && $ok_burst && $ok_alert && $ok_rules; then passed=true; fi
# jq escapes the messages: they carry values the player controls
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit store-serves "$ok_store" "$msg_store")" \
  "$(crit names-resolve "$ok_names" "$msg_names")" \
  "$(crit system-pods-stable "$ok_sys" "$msg_sys")" \
  "$(crit survives-burst "$ok_burst" "$msg_burst")" \
  "$(crit alerts-delivered "$ok_alert" "$msg_alert")" \
  "$(crit constraints "$ok_rules" "$msg_rules")"
