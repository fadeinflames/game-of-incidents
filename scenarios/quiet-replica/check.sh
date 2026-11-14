#!/bin/sh
# SECRET grader. Result, not method. The stand is watched for about 25 seconds under its normal client load:
#   1. authenticated requests succeed the whole time (a fresh token is issued and used, a seeded one is used too);
#   2. tokens are issued for installs of every integration, and the regular clients get theirs;
#   3. the primary keeps a wide margin of connection slots, and its limit is the one the DBA team set;
#   4. no transaction keeps rows of the permission tables locked for long (judged when 1 and 2 hold);
#   5. the standby is still a streaming standby of the primary and has caught up;
#   6. the permission data is intact: installs, integrations, the tokens the cleanup must keep, the counters.
# Nothing is read from files the player can edit: the clusters are asked over the local socket as the postgres
# superuser (psql -X), the API over HTTP (curl -q), the expected checksums are hard-coded (the seed is a pure function
# of the row number).
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE PGAPPNAME PGCLIENTENCODING PGDATESTYLE PGTZ
PGOPTIONS='-c statement_timeout=8000 -c lock_timeout=2000'; PGCONNECT_TIMEOUT=5
export PGOPTIONS PGCONNECT_TIMEOUT
SOCK=/var/run/postgresql
API=http://127.0.0.1:8080
SVC_TOKEN=gat_87acbf50432f77c754eaa4e66977d900   # the seeded service token of install 10, project 71

MAXCONN=40          # max_connections of the primary as shipped
CONN_OK=20          # client sessions on the primary the grader accepts at any moment of the window
ROUNDS=13
INSTALLS_N=16000; INSTALLS_MD5=a5c29103516831f3dd4c8d958be99747
INTEGR_N=20;      INTEGR_MD5=f12acc51d2c45a72a90513fc1243d66d
KEPT_N=9600;      KEPT_MD5=d4425f5356a266ae7e746c8ff4393442

tag="wom-grader-$$-$(date +%s)"
q() { runuser -u postgres -- psql -X -q -tA -F ' ' -h "$SOCK" -p "$1" -d authz -c "$2" </dev/null 2>/dev/null; }
is_num() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
get() { curl -q -s -o /dev/null -w '%{http_code}\n' --max-time 4 -H "Authorization: Bearer $2" "$API/v1/projects/$1" </dev/null 2>/dev/null | head -n 1; }
issue() { curl -q -s --max-time 5 -X POST -H 'Content-Type: application/json' --data "{\"label\":\"$tag\"}" "$API/v1/installs/$1/access_tokens" </dev/null 2>/dev/null; }

down="основной сервер (порт 5432, база authz) не отвечает на запросы"
ok_read=false;  msg_read="запросы с токеном не выполняются"
ok_token=false; msg_token="выпуск токенов не работает"
ok_conn=false;  msg_conn="$down"
ok_lock=false;  msg_lock="проверяется, когда запросы с токеном и выпуск токенов работают"
ok_repl=false;  msg_repl="резервный сервер (15/replica, порт 5433) не отвечает или не получает изменения с основного"
ok_data=false;  msg_data="$down"

# a stand that is still booting is given a moment
i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 30 ]; do i=$((i + 1)); sleep 0.5; done

mc=$(q 5432 "SHOW max_connections")
t0=$(q 5432 "SELECT extract(epoch FROM clock_timestamp())::numeric(20,3)")
case "$t0" in ''|*[!0-9.]*) t0="" ;; esac

if is_num "$mc" && [ -n "$t0" ]; then
  SAMPLE="SELECT (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid()),
   (SELECT count(DISTINCT a.pid) FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_locks l ON l.pid = a.pid
     WHERE a.pid <> pg_catalog.pg_backend_pid() AND a.xact_start < pg_catalog.clock_timestamp() - interval '10 seconds'
       AND l.locktype = 'relation' AND l.granted
       AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
       AND l.relation IN ('public.integrations'::regclass, 'public.installs'::regclass, 'public.access_tokens'::regclass)
       AND l.mode IN ('RowShareLock', 'RowExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'))"

  # the window: every round samples the primary, issues two tokens, uses them and uses a seeded token
  reads=0; reads_ok=0; tokens=0; tokens_ok=0; conn_max=0; holders_max=0; samples=0; r=0
  while [ $r -lt $ROUNDS ]; do
    r=$((r + 1))
    set -- $(q 5432 "$SAMPLE")
    if is_num "${1:-}" && is_num "${2:-}"; then
      samples=$((samples + 1))
      [ "$1" -gt $conn_max ] && conn_max=$1
      [ "$2" -gt $holders_max ] && holders_max=$2
    fi
    # a stand that is plainly down is not hammered for a minute
    if [ $((reads - reads_ok)) -ge 3 ] && [ $((tokens - tokens_ok)) -ge 2 ]; then break; fi
    for n in $((r * 2 - 1)) $((r * 2)); do
      tokens=$((tokens + 1)); reads=$((reads + 1))
      fresh=$(issue $n | sed -n 's/.*"token": *"\(gat_[0-9a-f]\{40\}\)".*/\1/p')
      if [ -n "$fresh" ]; then
        tokens_ok=$((tokens_ok + 1))
        [ "$(get $((1 + n * 7 % 900)) "$fresh")" = "200" ] && reads_ok=$((reads_ok + 1))
      fi
    done
    reads=$((reads + 1))
    [ "$(get 71 "$SVC_TOKEN")" = "200" ] && reads_ok=$((reads_ok + 1))
    [ $r -lt $ROUNDS ] && sleep 1.8
  done
  # an answer must come from the permission data, not from a stub: an unknown token is refused
  bogus=$(get 71 "gat_0000000000000000000000000000000000000000")
  stored=$(q 5432 "SELECT count(DISTINCT install_id) FROM public.access_tokens WHERE label = '$tag'")
  clients=$(q 5432 "SELECT count(*) FROM public.access_tokens WHERE label LIKE 'ci-job-%' AND created_at > to_timestamp($t0)")
  is_num "$stored" || stored=0
  is_num "$clients" || clients=0

  # 1
  if [ $reads_ok -ge $((reads - 1)) ] && [ $reads -ge $((ROUNDS * 3)) ] && [ "$bogus" = "401" ]; then
    ok_read=true; msg_read="запросы с токеном выполняются: $reads_ok из $reads за время проверки"
  elif [ $reads_ok -ge $((reads - 1)) ] && [ $reads -ge $((ROUNDS * 3)) ]; then
    msg_read="API отвечает 200, но не проверяет токен: запрос с несуществующим токеном получил $bogus вместо 401"
  else
    msg_read="запросы с токеном не выполняются: успешно $reads_ok из $reads"
  fi

  # 2
  if [ $tokens_ok -lt $((tokens - 1)) ] || [ $tokens -lt $((ROUNDS * 2)) ]; then
    msg_token="выпуск токенов не работает: выпущено $tokens_ok из $tokens"
  elif [ "$stored" -lt $((tokens_ok - 1)) ]; then
    msg_token="API отдаёт токены, но в таблице access_tokens основного сервера их нет"
  elif [ "$clients" -lt 3 ]; then
    msg_token="проверочные токены выпускаются, но обычные клиенты за время проверки получили только $clients: их запросы до сервиса не доходят"
  else
    ok_token=true; msg_token="токены выпускаются: $tokens_ok из $tokens проверочных, клиенты за это время получили $clients"
  fi

  # 3
  if [ "$mc" -ne $MAXCONN ]; then
    msg_conn="max_connections основного сервера изменён: было $MAXCONN, сейчас $mc. Параметры кластера менять нельзя"
  elif [ $samples -lt 1 ]; then
    msg_conn="$down"
  elif [ $conn_max -gt $CONN_OK ]; then
    msg_conn="у основного сервера нет запаса подключений: за время проверки было занято до $conn_max из $mc"
  else
    ok_conn=true; msg_conn="у основного сервера есть запас подключений: за время проверки занято не больше $conn_max из $mc"
  fi

  # 4. judged only when the service works, so that the first run of the grader says nothing about it
  if $ok_read && $ok_token; then
    if [ $samples -lt $((ROUNDS - 1)) ]; then
      msg_lock="$down"
    elif [ $holders_max -gt 0 ]; then
      msg_lock="сейчас сервис отвечает, но в таблицах прав есть транзакции, которые дольше 10 секунд держат блокировки (таких сессий: $holders_max): очередь соберётся снова"
    else
      ok_lock=true; msg_lock="строки таблиц прав никто не держит заблокированными надолго"
    fi
  fi

  # the grader's own tokens are removed together with their share of the counters; on a stand where the counter rows
  # are locked this gives up after two seconds, and the next run removes what is left
  q 5432 "WITH d AS (DELETE FROM public.access_tokens WHERE label LIKE 'wom-grader-%' RETURNING install_id),
               c AS (SELECT i.integration_id, count(*) AS n FROM d JOIN public.installs i ON i.id = d.install_id GROUP BY 1)
          UPDATE public.integrations g SET tokens_stored = g.tokens_stored - c.n FROM c WHERE g.id = c.integration_id" >/dev/null

  # 5. the standby: in recovery, streaming from the primary, and it has the newest token of the primary
  newest=$(q 5432 "SELECT max(id) FROM public.access_tokens")
  streaming=$(q 5432 "SELECT count(*) FROM pg_catalog.pg_stat_replication WHERE state = 'streaming'")
  if is_num "$newest" && is_num "$streaming" && [ "$streaming" -ge 1 ]; then
    i=0
    while [ $i -lt 6 ]; do
      set -- $(q 5433 "SELECT pg_catalog.pg_is_in_recovery(), (SELECT count(*) FROM pg_catalog.pg_stat_wal_receiver WHERE status = 'streaming'), (SELECT count(*) FROM public.installs), (SELECT count(*) FROM public.access_tokens WHERE id >= $newest)")
      if [ "${1:-}" = "t" ] && [ "${2:-}" = "1" ] && [ "${3:-}" = "$INSTALLS_N" ] && is_num "${4:-}" && [ "$4" -ge 1 ]; then
        ok_repl=true; msg_repl="резервный сервер (15/replica, порт 5433) получает изменения с основного"; break
      fi
      i=$((i + 1)); sleep 1
    done
  fi

  # 6
  set -- $(q 5432 "SELECT
    (SELECT count(*) FROM public.installs),
    (SELECT coalesce(md5(string_agg(id || '|' || integration_id || '|' || project_id || '|' || permissions::text, ',' ORDER BY id)), '-') FROM public.installs),
    (SELECT count(*) FROM public.integrations),
    (SELECT coalesce(md5(string_agg(id || '|' || slug || '|' || owner_team, ',' ORDER BY id)), '-') FROM public.integrations),
    (SELECT count(*) FROM public.access_tokens WHERE id <= $KEPT_N),
    (SELECT coalesce(md5(string_agg(id || '|' || install_id || '|' || encode(token_sha256, 'hex') || '|' || extract(epoch FROM expires_at)::bigint, ',' ORDER BY id)), '-') FROM public.access_tokens WHERE id <= $KEPT_N),
    (SELECT count(*) FROM public.integrations g WHERE g.tokens_stored <> (SELECT count(*) FROM public.access_tokens t JOIN public.installs i ON i.id = t.install_id WHERE i.integration_id = g.id)),
    (SELECT count(*) FROM public.sweep_progress)")
  if ! is_num "${1:-}" || ! is_num "${3:-}" || ! is_num "${5:-}" || ! is_num "${7:-}" || ! is_num "${8:-}"; then
    msg_data="таблицы прав в базе authz не читаются: integrations, installs, access_tokens и sweep_progress должны остаться на месте"
  elif [ "$1" -ne $INSTALLS_N ] || [ "$2" != "$INSTALLS_MD5" ]; then
    msg_data="таблица installs изменена: строк $1, должно быть $INSTALLS_N в исходном виде"
  elif [ "$3" -ne $INTEGR_N ] || [ "$4" != "$INTEGR_MD5" ]; then
    msg_data="таблица integrations изменена: строк $3, должно быть $INTEGR_N в исходном виде"
  elif [ "$5" -ne $KEPT_N ] || [ "$6" != "$KEPT_MD5" ]; then
    msg_data="пропали или изменены токены, которые должны остаться: сервисные и истёкшие после 2026-06-01 (на месте $5 из $KEPT_N)"
  elif [ "$7" -ne 0 ]; then
    msg_data="счётчики tokens_stored в integrations не сходятся с содержимым access_tokens (интеграций с расхождением: $7): данные меняли в обход сервисов"
  elif [ "$8" -ne $INTEGR_N ]; then
    msg_data="таблица sweep_progress изменена: строк $8, должно быть $INTEGR_N"
  else
    ok_data=true; msg_data="данные прав на месте и согласованы"
  fi
fi

passed=false
if $ok_read && $ok_token && $ok_conn && $ok_lock && $ok_repl && $ok_data; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"authenticated-requests","ok":%s,"message":"%s"},' "$ok_read" "$msg_read"
printf '{"id":"token-issuing","ok":%s,"message":"%s"},' "$ok_token" "$msg_token"
printf '{"id":"primary-headroom","ok":%s,"message":"%s"},' "$ok_conn" "$msg_conn"
printf '{"id":"no-long-locks","ok":%s,"message":"%s"},' "$ok_lock" "$msg_lock"
printf '{"id":"standby-streaming","ok":%s,"message":"%s"},' "$ok_repl" "$msg_repl"
printf '{"id":"data-intact","ok":%s,"message":"%s"}' "$ok_data" "$msg_data"
printf ']}\n'
