#!/bin/sh
# SECRET grader: the storm is over (at most one export running), the CronJob survived and cannot pile up again.
ok_cj=false;    msg_cj="CronJob nightly-export удалён: экспорт должен остаться"
ok_pol=false;   msg_pol="concurrencyPolicy всё ещё Allow: job'ы снова будут накапливаться"
ok_sched=false; msg_sched="расписание всё ещё каждую минуту"
ok_run=false;   msg_run="одновременно работает больше одного экспорта"
ok_api=false;   msg_api="api не в 2 Ready репликах"

if kubectl -n batch get cronjob nightly-export >/dev/null 2>&1; then ok_cj=true; msg_cj="CronJob nightly-export на месте"; fi
pol=$(kubectl -n batch get cronjob nightly-export -o jsonpath='{.spec.concurrencyPolicy}' 2>/dev/null)
case "$pol" in Forbid|Replace) ok_pol=true; msg_pol="concurrencyPolicy: $pol";; esac
sched=$(kubectl -n batch get cronjob nightly-export -o jsonpath='{.spec.schedule}' 2>/dev/null)
case "$sched" in
  "") ;;
  "* * * * *"|"*/1 * * * *") ;;
  *) ok_sched=true; msg_sched="расписание: $sched";;
esac

running=$(kubectl -n batch get pods -l app=nightly-export -o jsonpath='{range .items[*]}{.status.phase}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null | awk -F'|' '$1=="Running" && $2==""' | wc -l)
active=$(kubectl -n batch get jobs -l app=nightly-export -o jsonpath='{range .items[*]}{.status.active}{"\n"}{end}' 2>/dev/null | awk '$1>=1' | wc -l)
[ "$running" -le 1 ] && [ "$active" -le 1 ] && { ok_run=true; msg_run="работающих экспортов: $running"; }

aready=$(kubectl -n batch get deploy api -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${aready:-0}" = "2" ] && { ok_api=true; msg_api="api: 2 из 2 Ready"; }

passed=false
if $ok_cj && $ok_pol && $ok_sched && $ok_run && $ok_api; then passed=true; fi
# jq escapes the messages: they carry values the player controls, and a quote in them must not break the JSON
crit() { jq -cn --arg id "$1" --argjson ok "$2" --arg message "$3" '{"id":$id,"ok":$ok,"message":$message}'; }
printf '{"passed":%s,"criteria":[%s,%s,%s,%s,%s]}\n' "$passed" \
  "$(crit cronjob-exists "$ok_cj" "$msg_cj")" \
  "$(crit policy-not-allow "$ok_pol" "$msg_pol")" \
  "$(crit schedule-sane "$ok_sched" "$msg_sched")" \
  "$(crit single-export "$ok_run" "$msg_run")" \
  "$(crit api-healthy "$ok_api" "$msg_api")"
