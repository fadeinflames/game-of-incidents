#!/bin/sh
# SECRET grader. Result, not method:
#   1. the 6200 deleted orders are back in production exactly as they were (ids, numbers, amounts, statuses, dates);
#   2. what production wrote after the backup is untouched: the 2026 orders with their later status changes, the partner batch;
#   3. production accepts writes: the storefront keeps creating orders;
#   4. the regular replica is still a streaming standby of production and has the same rows;
#   5. production has no other WAL receiver: no temporary instance follows it.
# The expected checksums are hard-coded: the seed is a pure function of the row number, and break.sh adds fixed rows.
# Nothing is read from files the player can edit; the clusters are asked over the local socket as the postgres superuser.
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGPASSFILE PGAPPNAME PGCLIENTENCODING PGDATESTYLE PGTZ
SOCK=/var/run/postgresql

OLD_N=6200;  OLD_MD5=c585dd414f269524b5ebb4d137e1bc2a
KEPT_N=2200; KEPT_MD5=e1f2f0ff785c418a0de893186d742d68
PRT_N=150;   PRT_MD5=2c9e10cdea3a6e03f6f778ede9efdb43

q() { runuser -u postgres -- psql -X -q -tA -F ' ' -h "$SOCK" -p "$1" -d shop -c "$2" </dev/null 2>/dev/null; }
is_num() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

DATA_SQL="SELECT
 (SELECT count(*) FROM public.orders WHERE id BETWEEN 1 AND 6200),
 (SELECT coalesce(md5(string_agg(id || '|' || order_no || '|' || merchant_id || '|' || amount_cents || '|' || status || '|' || extract(epoch FROM created_at)::bigint, ',' ORDER BY id)), '-') FROM public.orders WHERE id BETWEEN 1 AND 6200),
 (SELECT count(*) FROM public.orders WHERE id BETWEEN 6201 AND 8400),
 (SELECT coalesce(md5(string_agg(id || '|' || order_no || '|' || merchant_id || '|' || amount_cents || '|' || status, ',' ORDER BY id)), '-') FROM public.orders WHERE id BETWEEN 6201 AND 8400),
 (SELECT count(*) FROM public.orders WHERE order_no ~ '^PRT-[0-9]{6}\$'),
 (SELECT coalesce(md5(string_agg(order_no || '|' || merchant_id || '|' || amount_cents || '|' || status, ',' ORDER BY order_no)), '-') FROM public.orders WHERE order_no ~ '^PRT-[0-9]{6}\$'),
 (SELECT (count(*) - count(DISTINCT id)) + (count(*) - count(DISTINCT order_no)) FROM public.orders),
 pg_catalog.pg_is_in_recovery()"

ok_rows=false;  msg_rows="прод не отвечает на запросы (порт 5432, база shop)"
ok_later=false; msg_later="прод не отвечает на запросы (порт 5432, база shop)"
ok_write=false; msg_write="прод не отвечает на запросы (порт 5432, база shop)"
ok_repl=false;  msg_repl="штатная реплика (15/replica, порт 5433) не отвечает или не получает изменения с прода"
ok_clean=false; msg_clean="проверяется после того, как удалённые заказы возвращены"

# 1-2. the table on production
set -- $(q 5432 "$DATA_SQL")
old_n=${1:-}; old_md5=${2:-}; kept_n=${3:-}; kept_md5=${4:-}; prt_n=${5:-}; prt_md5=${6:-}; dups=${7:-}; in_rec=${8:-}
if is_num "$old_n" && is_num "$kept_n" && is_num "$prt_n" && is_num "$dups"; then
  if [ "$old_n" -lt $OLD_N ]; then msg_rows="в orders на проде нет удалённых заказов: найдено $old_n из $OLD_N"
  elif [ "$old_n" -gt $OLD_N ]; then msg_rows="в orders на проде строк с id от 1 до $OLD_N больше, чем было до удаления: $old_n"
  elif [ "$old_md5" != "$OLD_MD5" ]; then msg_rows="заказы до 2026 года вернулись, но отличаются от исходных: id, номер, мерчант, сумма, статус и дата создания должны быть прежними"
  else ok_rows=true; msg_rows="все $OLD_N удалённых заказов снова в orders на проде, в прежнем виде"
  fi

  if [ "$dups" -ne 0 ]; then msg_later="в orders появились повторы id или номеров заказов"
  elif [ "$kept_n" -ne $KEPT_N ]; then msg_later="из заказов 2026 года (id от 6201 до 8400) на проде осталось $kept_n из $KEPT_N"
  elif [ "$prt_n" -ne $PRT_N ]; then msg_later="из партнёрской выгрузки, загруженной после бэкапа, на проде $prt_n заказов PRT из $PRT_N"
  elif [ "$kept_md5" != "$KEPT_MD5" ]; then msg_later="заказы 2026 года (id от 6201 до 8400) отличаются от того, что было на проде перед удалением: изменения, сделанные после бэкапа, должны остаться"
  elif [ "$prt_md5" != "$PRT_MD5" ]; then msg_later="заказы партнёрской выгрузки PRT изменены"
  else ok_later=true; msg_later="заказы 2026 года и партнёрская выгрузка на месте, изменения после бэкапа сохранены"
  fi

  # 3. production takes writes: the storefront adds an order every two seconds, and one must arrive while the grader
  #    watches (rows from before this run prove nothing: the writes may have stopped a moment ago)
  if [ "$in_rec" != "f" ]; then msg_write="прод работает только на чтение"
  else
    t0=$(q 5432 "SELECT extract(epoch FROM clock_timestamp())::numeric(20,3)")
    case "$t0" in ''|*[!0-9.]*) t0="" ;; esac
    i=0; fresh=0
    while [ -n "$t0" ] && [ $i -lt 6 ]; do
      sleep 2
      fresh=$(q 5432 "SELECT count(*) FROM public.orders WHERE id > 8400 AND order_no LIKE 'WEB-%' AND created_at > to_timestamp($t0)")
      is_num "$fresh" || fresh=0
      [ "$fresh" -ge 1 ] && break
      i=$((i + 1))
    done
    if [ "$fresh" -ge 1 ]; then ok_write=true; msg_write="прод принимает запись: storefront создаёт заказы"
    else msg_write="за 12 секунд проверки storefront не записал в orders ни одного нового заказа: запись в прод не работает"
    fi
  fi

  # 4. the regular replica: a standby that streams from production and has caught up with the table above
  want="t 1 $old_n $kept_n $prt_n"
  i=0; got=""
  while [ $i -lt 5 ]; do
    got=$(q 5433 "SELECT pg_catalog.pg_is_in_recovery(), (SELECT count(*) FROM pg_catalog.pg_stat_wal_receiver WHERE status = 'streaming'), (SELECT count(*) FROM public.orders WHERE id BETWEEN 1 AND 6200), (SELECT count(*) FROM public.orders WHERE id BETWEEN 6201 AND 8400), (SELECT count(*) FROM public.orders WHERE order_no ~ '^PRT-[0-9]{6}\$')")
    [ "$got" = "$want" ] && break
    i=$((i + 1)); sleep 2
  done
  # an open connection survives a reload of pg_hba.conf, so the rule that lets the replica come back is looked at as well
  hba=$(q 5432 "SELECT count(*) FROM pg_catalog.pg_hba_file_rules WHERE error IS NULL AND type LIKE 'host%' AND auth_method <> 'reject' AND 'replication' = ANY (database) AND (user_name && ARRAY['replicator', 'all'])")
  is_num "$hba" || hba=0
  if [ "$got" != "$want" ]; then :
  elif [ "$hba" -lt 1 ]; then msg_repl="штатная реплика пока подключена, но вернуться после разрыва не сможет: в pg_hba.conf прода нет правила репликации для неё"
  else ok_repl=true; msg_repl="штатная реплика (15/replica, порт 5433) получает изменения с прода"
  fi

  # 5. judged only when the rows are back, so that the first run of the grader says nothing about it
  if $ok_rows; then
    i=0; lo=999; hi=0
    while [ $i -lt 4 ]; do
      n=$(q 5432 "SELECT count(*) FROM pg_catalog.pg_stat_replication")
      is_num "$n" || n=0
      [ "$n" -lt $lo ] && lo=$n
      [ "$n" -gt $hi ] && hi=$n
      i=$((i + 1)); [ $i -lt 4 ] && sleep 2
    done
    if [ $hi -gt 1 ]; then msg_clean="у прода $hi получателя WAL (pg_stat_replication), а штатная реплика одна: за продом всё ещё следует лишний экземпляр"
    elif [ $lo -lt 1 ]; then msg_clean="у прода нет получателей WAL: штатная реплика отключена"
    else ok_clean=true; msg_clean="у прода один получатель WAL, штатная реплика; временные экземпляры за ним не следуют"
    fi
  fi
fi

passed=false
if $ok_rows && $ok_later && $ok_write && $ok_repl && $ok_clean; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"rows-restored","ok":%s,"message":"%s"},' "$ok_rows" "$msg_rows"
printf '{"id":"later-data-intact","ok":%s,"message":"%s"},' "$ok_later" "$msg_later"
printf '{"id":"prod-accepts-writes","ok":%s,"message":"%s"},' "$ok_write" "$msg_write"
printf '{"id":"replica-healthy","ok":%s,"message":"%s"},' "$ok_repl" "$msg_repl"
printf '{"id":"aftermath-clean","ok":%s,"message":"%s"}' "$ok_clean" "$msg_clean"
printf ']}\n'
