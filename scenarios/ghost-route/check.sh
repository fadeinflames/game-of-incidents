#!/bin/sh
# SECRET grader: the API answers JSON again, the SPA (including its client-side routes) still works, both client
# populations are happy, the ingress controller is untouched. The clients' 60 s window needs up to a minute after a repair
# to wash the old failures out, so once the probes pass the stats get up to ~90 s of retries.

probe() { # host path -> "code|content-type|snippet"
  kubectl exec deploy/clients -- python3 -c 'import sys, urllib.request as u, urllib.error as e
h, p = sys.argv[1], sys.argv[2]
try:
    r = u.urlopen(u.Request("http://ingress-nginx-controller.ingress-nginx.svc" + p, headers={"Host": h}), timeout=4)
    print(str(r.status) + "|" + r.headers.get("Content-Type", "") + "|" + repr(r.read(120).decode(errors="replace")))
except e.HTTPError as x: print(str(x.code) + "|" + x.headers.get("Content-Type", "") + "|")
except Exception as x: print(f"0||{x}")' "$1" "$2" 2>/dev/null | tr -d '\r'
}

rate_msg() { # per-mille, label -> rate_ok, rate_text
  if [ "$1" -ge 950 ]; then rate_ok=true; rate_text="$2: success rate $(($1 / 10)) %"
  elif [ "$1" -lt 0 ]; then rate_ok=false; rate_text="$2: окно метрик за последнюю минуту пока пустое, подожди и проверь снова"
  else
    rate_ok=false; rate_text="$2: success rate $(($1 / 10)) % (< 95 %)"
    $ok_api && $ok_web && rate_text="$rate_text; окно в 60 с обновляется не сразу, подожди и проверь снова"
  fi
}

evaluate() {
  ok_api=false;  msg_api="api.shop.local/api/orders через ingress не отдаёт JSON"
  ok_web=false;  msg_web="shop.local/ или shop.local/products/42 не отдают HTML каталога"
  ok_mob=false;  msg_mob="мобильные клиенты всё ещё получают ошибки (success rate < 95 %)"
  ok_brw=false;  msg_brw="браузерные клиенты получают ошибки (success rate < 95 %)"
  ok_ctl=false;  msg_ctl="ingress-nginx-controller не Ready или удалён"

  api=$(probe api.shop.local /api/orders)
  case "$api" in 200\|*application/json*orders*) ok_api=true; msg_api="api.shop.local/api/orders отдаёт JSON";; esac

  w1=$(probe shop.local /); w2=$(probe shop.local /products/42)
  case "$w1" in 200\|*text/html*) case "$w2" in 200\|*text/html*) ok_web=true; msg_web="shop.local/ и /products/42 отдают HTML каталога";; esac;; esac

  stats=$(kubectl exec deploy/clients -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); print(d["mobile"]["success_rate"] if d["mobile"]["success_rate"] is not None else -1, d["browser"]["success_rate"] if d["browser"]["success_rate"] is not None else -1)' 2>/dev/null | tr -d '\r')
  mob=$(printf '%s' "${stats:--1 -1}" | awk '{printf "%d", $1*1000+0.5}'); brw=$(printf '%s' "${stats:--1 -1}" | awk '{printf "%d", $2*1000+0.5}')
  rate_msg "$mob" "мобильные клиенты"; ok_mob=$rate_ok; msg_mob=$rate_text
  rate_msg "$brw" "браузерные клиенты"; ok_brw=$rate_ok; msg_brw=$rate_text

  cready=$(kubectl -n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
  [ "${cready:-0}" -ge 1 ] && { ok_ctl=true; msg_ctl="ingress-nginx-controller Ready"; }
}

deadline=$(( $(date +%s) + 90 ))
while :; do
  evaluate
  if $ok_api && $ok_web && $ok_mob && $ok_brw && $ok_ctl; then break; fi
  # only a repaired routing converges: if the probes themselves fail, waiting for the window is pointless
  { $ok_api && $ok_web; } || break
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 5
done

passed=false
if $ok_api && $ok_web && $ok_mob && $ok_brw && $ok_ctl; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"api-json","ok":%s,"message":"%s"},' "$ok_api" "$msg_api"
printf '{"id":"web-html","ok":%s,"message":"%s"},' "$ok_web" "$msg_web"
printf '{"id":"mobile-served","ok":%s,"message":"%s"},' "$ok_mob" "$msg_mob"
printf '{"id":"browsers-served","ok":%s,"message":"%s"},' "$ok_brw" "$msg_brw"
printf '{"id":"controller-intact","ok":%s,"message":"%s"}' "$ok_ctl" "$msg_ctl"
printf ']}\n'
