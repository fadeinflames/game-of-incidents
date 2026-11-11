#!/bin/sh
# SECRET grader. Result, not method:
#   the edge serves and scores requests, the features file is valid and fresh (the generator works), the generator
#   produces a valid set from the node where the access change is already applied, and that change is still in place.
# The connection string is not read from /etc/featuregen/featuregen.conf: the player can edit that file.
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
FEATURES=/var/lib/edge/features/current.json
N1_DSN="host=127.0.0.1 port=5432 dbname=analytics_n1 user=featuregen password=fg-r3adonly"
LIMIT=200

ok_serve=false; msg_serve="граница отвечает клиентам ошибками"
ok_score=false; msg_score="ответы приходят без оценки бота (заголовок X-Bot-Score)"
ok_file=false;  msg_file="файл признаков для прокси некорректен или давно не обновлялся"
ok_gen=false;   msg_gen="генератор собирает набор признаков, который прокси не примет"
ok_acl=false;   msg_acl="изменение доступа SEC-2291 на узле n1 откатано"

# 1-2. twelve requests over about six seconds: all 200, all scored
total=0; good=0; scored=0
while [ $total -lt 12 ]; do
  out=$(curl -q -s --max-time 3 -D - -o /dev/null -H 'X-Client: grader' "http://127.0.0.1/api/v1/items/$total" </dev/null 2>/dev/null)
  case "$out" in
    "HTTP/1.1 200"*)
      good=$((good + 1))
      if printf '%s\n' "$out" | grep -qi '^x-bot-score: *[0-9]'; then scored=$((scored + 1)); fi ;;
  esac
  total=$((total + 1)); sleep 0.5
done
if [ $good -eq $total ]; then ok_serve=true; msg_serve="граница отвечает 200 ($good из $total)"; else msg_serve="граница отвечает 200 только на $good из $total запросов"; fi
if [ $good -gt 0 ] && [ $scored -eq $good ]; then ok_score=true; msg_score="каждый ответ несёт оценку бота"; fi

# 3. the file the proxy reads: fits the table, no duplicates, written by the generator within the last 90 seconds
state=$(python3 -c 'import json,sys,time
try:
    d = json.load(open(sys.argv[1]))
    names = [f["name"] for f in d["features"]]
    print(len(names), len(set(names)), int(time.time()) - int(d["version"]))
except Exception:
    print("x x x")' "$FEATURES" </dev/null 2>/dev/null)
set -- $state
n=${1:-x}; uniq=${2:-x}; age=${3:-x}
case "$n$uniq$age" in
  *[!0-9-]*|'') msg_file="файл признаков не читается как JSON с версией и списком признаков" ;;
  *)
    if [ "$n" -lt 1 ] || [ "$n" -gt $LIMIT ]; then msg_file="в файле признаков $n записей, прокси принимает от 1 до $LIMIT"
    elif [ "$uniq" -ne "$n" ]; then msg_file="в файле признаков есть повторы ($n записей, $uniq разных)"
    elif [ "$age" -gt 90 ] || [ "$age" -lt -5 ]; then msg_file="файл признаков не обновлялся ${age} с: генератор должен работать"
    else ok_file=true; msg_file="файл признаков корректен и свежий ($n признаков)"
    fi ;;
esac

# 4. what the generator would write from node n1 right now, with the query and config that are on the host
dry=$(python3 /opt/featuregen/featuregen.py --dry-run --dsn "$N1_DSN" </dev/null 2>/dev/null)
set -- $(printf '%s' "$dry" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(int(d["features"]), int(d["unique"]))
except Exception:
    print("x x")' 2>/dev/null)
g=${1:-x}; gu=${2:-x}
case "$g$gu" in
  *[!0-9]*|'') msg_gen="генератор не смог собрать набор признаков с узла n1" ;;
  *)
    if [ "$g" -ge 100 ] && [ "$g" -le $LIMIT ] && [ "$g" -eq "$gu" ]; then ok_gen=true; msg_gen="с узла n1 генератор собирает корректный набор ($g признаков)"
    else msg_gen="с узла n1 генератор собирает $g записей ($gu разных); прокси принимает до $LIMIT без повторов"
    fi ;;
esac

# 5. the access change is a requirement of the security team: it stays
q="SELECT has_table_privilege('featuregen', 'shard0.request_features', 'SELECT')"
acl=$(su postgres -c "psql -X -q -tA -d analytics_n1 -c \"$q\"" </dev/null 2>/dev/null)
if [ "$acl" = "t" ]; then ok_acl=true; msg_acl="изменение доступа SEC-2291 на месте"; fi

passed=false
if $ok_serve && $ok_score && $ok_file && $ok_gen && $ok_acl; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"edge-serves","ok":%s,"message":"%s"},' "$ok_serve" "$msg_serve"
printf '{"id":"bot-score-on","ok":%s,"message":"%s"},' "$ok_score" "$msg_score"
printf '{"id":"features-file","ok":%s,"message":"%s"},' "$ok_file" "$msg_file"
printf '{"id":"generator-safe","ok":%s,"message":"%s"},' "$ok_gen" "$msg_gen"
printf '{"id":"access-change-kept","ok":%s,"message":"%s"}' "$ok_acl" "$msg_acl"
printf ']}\n'
