#!/bin/sh
# SECRET. Nothing in the pod spec or in the configuration changes. The night ETL loads the history of a new sales
# channel (+300 000 orders); with it the hash table of the report's parallel hash join no longer fits into the
# 64 MB /dev/shm of the database container, and the morning report fails with "No space left on device".
# Order: wait for the seeded database, run yesterday's report (it passes), load, run today's report (it fails).
# One shared deadline: the whole script stays under 150 s.
set -u
t0=$(date +%s)
left() { r=$(( $1 - ($(date +%s) - t0) )); [ "$r" -lt 3 ] && r=3; echo "$r"; }
fail() { echo "break: FAILED, $1" >&2; exit 1; }
sql() { kubectl exec sales-db-0 -c postgres -- psql -X -q -U postgres -d sales -tA -c "$1" </dev/null 2>/dev/null; }

# 1. the database is up and the first start has finished loading the baseline
n=""
while [ $(( $(date +%s) - t0 )) -lt 100 ]; do
  ready=$(kubectl get pod sales-db-0 -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
  if [ "$ready" = "True" ]; then
    n=$(sql "select count(*) from sales.orders" | tr -dc '0-9')
    [ "$n" = "600000" ] && break
    [ "$n" = "900000" ] && { echo "break: the load is already in place"; break; }
  fi
  sleep 2
done
[ "$n" = "600000" ] || [ "$n" = "900000" ] || fail "sales-db is not ready with the baseline data (orders: ${n:-none})"

# job names look like the ones the CronJob controller gives: <cronjob>-<scheduled time in minutes>
last=$(( ( ($(date +%s) - 21600) / 86400 ) * 86400 + 21600 ))
job_prev="revenue-report-$(( (last - 86400) / 60 ))"
job_last="revenue-report-$(( last / 60 ))"

# 2. yesterday's run: the report passes on the data as it was (also proves the baseline really fits)
if [ "$n" = "600000" ]; then
  kubectl delete job "$job_prev" --ignore-not-found >/dev/null 2>&1
  kubectl create job "$job_prev" --from=cronjob/revenue-report >/dev/null || fail "cannot create $job_prev"
  kubectl wait --for=condition=complete "job/$job_prev" --timeout="$(left 125)s" >/dev/null 2>&1 \
    || fail "the report does not pass on the baseline data: $(kubectl logs "job/$job_prev" --tail=3 2>&1 | tr '\n' ' ')"

  # 3. the night load: history of the marketplace channel, same shape as the rest of the data
  kubectl exec -i sales-db-0 -c postgres -- psql -X -q -v ON_ERROR_STOP=1 -U etl -d sales >/dev/null <<'SQL' || fail "the night load did not go through"
BEGIN;
INSERT INTO sales.orders
SELECT g,
       date_trunc('day', now()) - (1 + g % 300) * interval '1 day' + (g % 86400) * interval '1 second',
       ((g::bigint * 7919) % 180000)::int,
       (ARRAY['Moscow','Saint Petersburg','Novosibirsk','Yekaterinburg','Kazan','Nizhny Novgorod',
              'Chelyabinsk','Samara','Omsk','Rostov-on-Don','Ufa','Krasnoyarsk'])[1 + g % 12],
       'marketplace',
       CASE WHEN g % 50 = 0 THEN 'refunded' ELSE 'paid' END
FROM generate_series(600001, 900000) g;
INSERT INTO sales.order_items
SELECT 600001 + (g % 300000), (g * 31) % 5000, 1 + g % 3, (100 + (g * 37) % 9900)::numeric / 10
FROM generate_series(1, 600000) g;
INSERT INTO etl.load_log (loaded_at, source, orders, items, note)
VALUES (date_trunc('day', now() - interval '3 hours') + interval '2 hours 10 minutes', 'daily-increment', 1964, 3928, 'web, mobile, retail'),
       (date_trunc('day', now() - interval '3 hours') + interval '2 hours 31 minutes', 'marketplace-backfill', 300000, 600000, 'DATA-731: history of the new marketplace channel');
COMMIT;
ANALYZE sales.orders;
ANALYZE sales.order_items;
SQL
fi

# 4. this morning's run fails; wait until the failure and its message are visible
kubectl delete job "$job_last" --ignore-not-found >/dev/null 2>&1
kubectl create job "$job_last" --from=cronjob/revenue-report >/dev/null || fail "cannot create $job_last"
log=""
while [ $(( $(date +%s) - t0 )) -lt 147 ]; do
  failed=$(kubectl get job "$job_last" -o jsonpath='{.status.failed}' 2>/dev/null)
  if [ "${failed:-0}" -ge 1 ]; then
    for p in $(kubectl get pods -l "job-name=$job_last" --field-selector=status.phase=Failed -o name 2>/dev/null); do
      log=$(kubectl logs "$p" --tail=5 2>/dev/null)
      echo "$log" | grep -q "No space left on device" && { echo "break: done ($job_last failed: $(echo "$log" | grep -m1 ERROR))"; exit 0; }
    done
  fi
  [ "$(kubectl get job "$job_last" -o jsonpath='{.status.succeeded}' 2>/dev/null)" = "1" ] && fail "the report still passes after the load"
  sleep 2
done
fail "the report did not fail as expected: $(echo "$log" | tr '\n' ' ')"
