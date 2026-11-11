#!/bin/sh
# SECRET grader. Result, not method:
#   1. the database pod is Ready and still keeps its data on the original PVC;
#   2. the data is whole, the night load included (deterministic data: exact counts and sums);
#   3. the query settings in effect for the report role are not lowered (no "turn parallel query off", no tiny work_mem);
#   4. the report query, run here as the report role with those settings, finishes with a parallel hash join
#      and launched workers (so the shared memory it needs is really available, whichever way that was achieved);
#   5. the materialized view behind the dashboard was rebuilt on the full data and the CronJob is still there.
# Nothing is read from files or environment the player can edit: psql is started with an empty environment, -X,
# over the local socket; the report query and the expected numbers are hard-coded. No side effects (EXPLAIN ANALYZE of a SELECT).

WANT_DATA="900000 405000450000 1800000 1817839740.00"
WANT_VIEW="m 48 1764000 1781507310.00"
REPORT_QUERY="SELECT o.city, o.channel, count(*) AS items, sum(i.qty * i.price) AS revenue FROM sales.order_items i JOIN sales.orders o ON o.id = i.order_id WHERE o.status = 'paid' GROUP BY o.city, o.channel"

pq() { role=$1; shift; kubectl exec sales-db-0 -c postgres -- env -i /usr/local/bin/psql -X -q -U "$role" -d sales -tA -F ' ' "$@" </dev/null 2>&1; }

ok_db=false;   msg_db="база sales-db не готова: под sales-db-0 не Ready или его данные лежат не на томе data-sales-db-0"
ok_data=false; msg_data="не удалось прочитать таблицы sales.orders и sales.order_items"
ok_set=false;  msg_set="не удалось прочитать настройки запросов для роли report"
ok_run=false;  msg_run="запрос отчёта от роли report завершается ошибкой"
ok_view=false; msg_view="витрина reporting.revenue_by_channel не пересобрана на данных ночной загрузки"

# 1. pod Ready, not terminating, rollout finished, data directory on the PVC of the StatefulSet (wait a little for a rollout)
i=0
while [ $i -lt 6 ]; do
  pod=$(kubectl get pod sales-db-0 -o json 2>/dev/null | jq -r '
    ((.spec.volumes // []) | map(select(.persistentVolumeClaim.claimName == "data-sales-db-0")) | first | .name // "") as $v
    | [ ((.status.conditions // []) | map(select(.type == "Ready")) | first | .status // "False"),
        (if .metadata.deletionTimestamp then "terminating" else "live" end),
        (if $v != "" and ((.spec.containers[0].volumeMounts // []) | any(.name == $v and .mountPath == "/var/lib/postgresql/data")) then "pvc" else "nopvc" end)
      ] | join(" ")' 2>/dev/null)
  rev=$(kubectl get statefulset sales-db -o jsonpath='{.status.currentRevision} {.status.updateRevision} {.status.readyReplicas}' 2>/dev/null)
  set -- $rev
  if [ "$pod" = "True live pvc" ] && [ -n "${1:-}" ] && [ "${1:-}" = "${2:-}" ] && [ "${3:-0}" = "1" ]; then
    dir=$(pq postgres -c "show data_directory")
    if [ "$dir" = "/var/lib/postgresql/data/pgdata" ]; then ok_db=true; msg_db="sales-db-0 в состоянии Ready, данные на томе data-sales-db-0"; break; fi
  fi
  i=$((i + 1)); sleep 5
done

if $ok_db; then
  # 2. data: exact counts and sums of both tables
  data=$(pq postgres -c "set max_parallel_workers_per_gather = 0" -c "select (select count(*) from sales.orders), (select coalesce(sum(id), 0) from sales.orders), (select count(*) from sales.order_items), (select coalesce(sum(qty * price), 0) from sales.order_items)")
  if [ "$data" = "$WANT_DATA" ]; then
    ok_data=true; msg_data="данные на месте: 900000 заказов, 1800000 позиций"
  elif echo "$data" | grep -Eq '^[0-9]+ [0-9]+ [0-9]+ [0-9.]+$'; then
    set -- $data
    msg_data="в sales.orders и sales.order_items не те данные, что после ночной загрузки (заказов $1, позиций $3): данные должны остаться целыми"
  fi

  # 3. settings in effect for the report role (role, database, ALTER SYSTEM and the config file all end up here)
  st=$(pq report -c "select current_setting('max_parallel_workers_per_gather')::int, (select setting from pg_settings where name = 'work_mem'), (current_setting('hash_mem_multiplier')::numeric * 100)::int, current_setting('enable_parallel_hash'), current_setting('max_parallel_workers')::int, current_setting('max_worker_processes')::int")
  if echo "$st" | grep -Eq '^[0-9]+ [0-9]+ [0-9]+ (on|off) [0-9]+ [0-9]+$'; then
    set -- $st
    low=""
    [ "$1" -ge 2 ] || low="max_parallel_workers_per_gather = $1"
    [ "$2" -ge 32768 ] || low="${low:+$low, }work_mem = $2 kB"
    [ "$3" -ge 200 ] || low="${low:+$low, }hash_mem_multiplier ниже 2"
    [ "$4" = "on" ] || low="${low:+$low, }enable_parallel_hash = off"
    [ "$5" -ge 2 ] || low="${low:+$low, }max_parallel_workers = $5"
    [ "$6" -ge 3 ] || low="${low:+$low, }max_worker_processes = $6"
    if [ -z "$low" ]; then ok_set=true; msg_set="настройки запросов для роли report не занижены"
    else msg_set="настройки запросов для роли report занижены ($low): снижать их нельзя"; fi
  fi

  # 4. the report query itself, a few attempts (a restart may still be settling, another run may hold the memory)
  i=0
  while [ $i -lt 3 ]; do
    plan=$(pq report -c "set statement_timeout = '120s'" -c "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) $REPORT_QUERY")
    if echo "$plan" | grep -q "Execution Time:" && ! echo "$plan" | grep -q "ERROR:"; then
      w=$(echo "$plan" | grep -m1 "Workers Launched:" | tr -dc '0-9')
      if [ "${w:-0}" -ge 1 ] && echo "$plan" | grep -q "Parallel Hash Join"; then
        ok_run=true; msg_run="запрос отчёта выполняется параллельным планом (воркеров: $w)"
      else
        msg_run="запрос отчёта выполняется, но не параллельным планом: параллельные запросы должны работать как раньше"
      fi
      break
    fi
    i=$((i + 1)); [ $i -lt 3 ] && sleep 5
  done

  # 5. the dashboard source is rebuilt on the full data; the CronJob still exists and is not suspended
  view=$(pq postgres -c "select (select relkind from pg_class where oid = 'reporting.revenue_by_channel'::regclass), count(*), coalesce(sum(items), 0), coalesce(sum(revenue), 0) from reporting.revenue_by_channel")
  cj=$(kubectl get cronjob revenue-report -o json 2>/dev/null | jq -r 'if .spec.suspend == true then "suspended" else "active" end' 2>/dev/null)
  if [ "$cj" != "active" ]; then
    msg_view="CronJob revenue-report удалён или приостановлен: отчёт должен собираться по расписанию"
  elif [ "$view" = "$WANT_VIEW" ]; then
    ok_view=true; msg_view="витрина reporting.revenue_by_channel пересобрана на полных данных"
  fi
fi

passed=false
if $ok_db && $ok_data && $ok_set && $ok_run && $ok_view; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"db-ready","ok":%s,"message":"%s"},' "$ok_db" "$msg_db"
printf '{"id":"data-intact","ok":%s,"message":"%s"},' "$ok_data" "$msg_data"
printf '{"id":"settings-kept","ok":%s,"message":"%s"},' "$ok_set" "$msg_set"
printf '{"id":"report-runs","ok":%s,"message":"%s"},' "$ok_run" "$msg_run"
printf '{"id":"dashboard-fresh","ok":%s,"message":"%s"}' "$ok_view" "$msg_view"
printf ']}\n'
