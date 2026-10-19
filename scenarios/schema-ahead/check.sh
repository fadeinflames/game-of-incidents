#!/bin/sh
# SECRET grader: reads and writes work again, the data survived, what the API returns matches what the DB holds,
# and the running code + schema are consistent (either path: schema back for 1.9.4, or 2.0.0 shipped properly).
ok_ready=false; msg_ready="billing-api не в 2 из 2 Ready"
ok_read=false;  msg_read="GET /invoices не отвечает 200"
ok_write=false; msg_write="POST /invoices не проходит"
ok_data=false;  msg_data="данные счетов потеряны или расходятся с базой"
ok_rate=false;  msg_rate="клиенты всё ещё получают ошибки (success rate за минуту ниже 95 %)"
ok_pg=false;    msg_pg="postgres не Ready"

http() { # method path [json]
  kubectl exec deploy/traffic -- python3 -c 'import sys, json, urllib.request as u, urllib.error as e
m, p = sys.argv[1], sys.argv[2]; d = sys.argv[3].encode() if len(sys.argv) > 3 else None
req = u.Request("http://billing-api" + p, data=d, method=m, headers={"Content-Type": "application/json"})
try:
    r = u.urlopen(req, timeout=5); print(r.status); print(r.read().decode())
except e.HTTPError as x: print(x.code)
except Exception: print(0)' "$@" 2>/dev/null | tr -d '\r'
}

ready=$(kubectl get deploy billing-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${ready:-0}" = "2" ] && { ok_ready=true; msg_ready="billing-api: 2 из 2 Ready"; }
pgready=$(kubectl get pod postgres-0 -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)
[ "$pgready" = "true" ] && { ok_pg=true; msg_pg="postgres Ready"; }

out=$(http GET /invoices)
code=$(printf '%s\n' "$out" | head -1)
body=$(printf '%s\n' "$out" | tail -n +2)
[ "$code" = "200" ] && { ok_read=true; msg_read="GET /invoices отвечает 200"; }

# what the API says vs what the DB holds (either column may carry the amounts now)
api_sig=$(printf '%s' "$body" | jq -r '.invoices | sort_by(.id) | map("\(.id):\(.total_cents)") | join(",")' 2>/dev/null)
# The load generator keeps inserting invoices between the API snapshot above and the DB snapshot below. Ids only grow,
# so the DB side is cut at the highest id the API has returned: both snapshots then cover the same rows.
maxid=$(printf '%s' "$body" | jq -r '[.invoices[].id] | max // 0' 2>/dev/null)
case "$maxid" in ''|*[!0-9]*) maxid=0 ;; esac
cols=$(kubectl exec postgres-0 -- psql -X -U billing -d billing -tA -c "select string_agg(column_name, ',') from information_schema.columns where table_name='invoices' and column_name in ('total_cents','amount_cents')" 2>/dev/null | tr -d '\r')
case "$cols" in
  *total_cents*amount_cents*|*amount_cents*total_cents*) expr="coalesce(total_cents, amount_cents)";;
  *amount_cents*) expr="amount_cents";;
  *) expr="total_cents";;
esac
db_sig=$(kubectl exec postgres-0 -- psql -X -U billing -d billing -tA -c "select string_agg(id || ':' || $expr, ',' order by id) from invoices where id <= $maxid" 2>/dev/null | tr -d '\r')
count=$(kubectl exec postgres-0 -- psql -X -U billing -d billing -tA -c "select count(*) from invoices where customer like 'customer-%'" 2>/dev/null | tr -d '\r')
marker=$(kubectl exec postgres-0 -- psql -X -U billing -d billing -tA -c "select count(*) from invoices where customer='incident-marker'" 2>/dev/null | tr -d '\r')
if [ "$ok_read" = true ] && [ -n "$db_sig" ] && [ "$api_sig" = "$db_sig" ] && [ "${count:-0}" -ge 20 ] && [ "${marker:-0}" = 1 ]; then ok_data=true; msg_data="API отдаёт ровно то, что в базе ($count исходных счетов на месте)"; fi

wcode=$(http POST /invoices '{"customer":"grader","total_cents":4242}' | head -1)
[ "$wcode" = "201" ] && { ok_write=true; msg_write="POST /invoices проходит"; }

rate=$(kubectl exec deploy/traffic -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/stats",timeout=3)); print(d["success_rate"] if d["success_rate"] is not None else -1)' 2>/dev/null | tr -d '\r')
pct=$(printf '%s' "${rate:--1}" | awk '{printf "%d", $1*100}')
[ "$pct" -ge 95 ] && { ok_rate=true; msg_rate="success rate клиентов за минуту: $pct %"; }

passed=false
if $ok_ready && $ok_read && $ok_write && $ok_data && $ok_rate && $ok_pg; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"api-ready","ok":%s,"message":"%s"},' "$ok_ready" "$msg_ready"
printf '{"id":"reads-work","ok":%s,"message":"%s"},' "$ok_read" "$msg_read"
printf '{"id":"writes-work","ok":%s,"message":"%s"},' "$ok_write" "$msg_write"
printf '{"id":"data-consistent","ok":%s,"message":"%s"},' "$ok_data" "$msg_data"
printf '{"id":"customers-served","ok":%s,"message":"%s"},' "$ok_rate" "$msg_rate"
printf '{"id":"postgres-ready","ok":%s,"message":"%s"}' "$ok_pg" "$msg_pg"
printf ']}\n'
