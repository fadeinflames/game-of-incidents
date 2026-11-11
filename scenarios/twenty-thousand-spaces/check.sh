#!/bin/sh
# SECRET grader. Result, not method:
#   the site answers through the balancer, both servers take traffic, the home page is fast, and a new post with the same
#   kind of content does not bring the site down again. The test post is removed afterwards.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
URL=http://127.0.0.1
DB=/var/lib/forum/forum.db
NONCE="grader-$(date +%s)-$$"

ok_up=false;    msg_up="сайт не отвечает через балансировщик"
ok_both=false;  msg_both="трафик получают не оба сервера"
ok_fast=false;  msg_fast="главная страница отвечает медленно или с ошибкой"
ok_again=false; msg_again="проверка не выполнялась: сайт недоступен"

fast() { awk -v t="$1" 'BEGIN { exit !(t + 0 < 1.0) }' </dev/null; }

# 1. an ordinary page and the home page through the balancer
i=0; code_q=000
while [ $i -lt 3 ]; do
  code_q=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/questions/1" </dev/null 2>/dev/null || echo 000)
  [ "$code_q" = "200" ] && break
  i=$((i + 1)); sleep 1
done
set -- $(curl -q -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 5 "$URL/" </dev/null 2>/dev/null || echo "000 9")
code_h=${1:-000}; t_h=${2:-9}
if [ "$code_q" = "200" ] && [ "$code_h" = "200" ]; then ok_up=true; msg_up="сайт отвечает через балансировщик"; else msg_up="через балансировщик: страница вопроса $code_q, главная $code_h"; fi
if [ "$code_h" = "200" ] && fast "$t_h"; then ok_fast=true; msg_fast="главная отвечает за ${t_h} с"; elif [ "$code_h" = "200" ]; then msg_fast="главная отвечает за ${t_h} с, это слишком долго"; fi

# 2. both servers are in rotation: eight requests must be answered by both
seen=""
i=0
while [ $i -lt 8 ]; do
  who=$(curl -q -s -o /dev/null -D - --max-time 5 "$URL/questions/2" </dev/null 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "x-served-by:" { print $2 }')
  case " $seen " in *" $who "*) ;; *) seen="$seen $who" ;; esac
  i=$((i + 1))
done
case " $seen " in *" web1 "*) case " $seen " in *" web2 "*) ok_both=true; msg_both="оба сервера в ротации" ;; esac ;; esac

# 3. a visitor posts the same kind of content again: for nine seconds (three check intervals) the home page must stay fast
if $ok_up; then
  posted=$(python3 -c 'import json, sys, urllib.request, urllib.error
body = "\n".join(["Повтор проблемы:", "    def handle(msg):", "        # FIXME" + " " * 20000 + "тут", "    return None"])
req = urllib.request.Request(sys.argv[1] + "/questions", data=json.dumps({"title": sys.argv[2], "body": body, "author": "visitor"}).encode(), headers={"Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req, timeout=8).status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print(0)' "$URL" "$NONCE" </dev/null 2>/dev/null)
  bad=0; slowest=0; n=0; shown=false
  while [ $n -lt 6 ]; do
    sleep 1.5
    out=$(curl -q -s -w '\n%{http_code} %{time_total}' --max-time 5 "$URL/" </dev/null 2>/dev/null || printf '\n000 9')
    set -- $(printf '%s\n' "$out" | tail -n 1)
    c=${1:-000}; t=${2:-9}
    if [ "$c" != "200" ] || ! fast "$t"; then bad=$((bad + 1)); fi
    slowest=$(awk -v a="$slowest" -v b="$t" 'BEGIN { print (b + 0 > a + 0) ? b : a }' </dev/null)
    case "$out" in *"$NONCE"*) shown=true ;; esac
    n=$((n + 1))
  done
  # the test post goes away whatever the verdict
  python3 -c 'import sqlite3, sys
c = sqlite3.connect(sys.argv[1], timeout=10)
c.execute("DELETE FROM questions WHERE title = ?", (sys.argv[2],))
c.commit()' "$DB" "$NONCE" </dev/null 2>/dev/null
  case "$posted" in
    201)
      if [ $bad -eq 0 ] && $shown; then ok_again=true; msg_again="новый пост с таким же содержимым сайт пережил (главная не медленнее ${slowest} с)"
      elif [ $bad -eq 0 ]; then msg_again="новый пост принят, но на главной не появился"
      else msg_again="после нового поста с таким же содержимым главная снова тормозит или недоступна ($bad проверок из 6)"
      fi ;;
    4??)
      if [ $bad -eq 0 ]; then ok_again=true; msg_again="пост с таким содержимым отклонён при публикации, главная стабильна"
      else msg_again="главная тормозит или недоступна ($bad проверок из 6)"
      fi ;;
    *) msg_again="не удалось опубликовать тестовый пост (ответ ${posted:-нет})" ;;
  esac
fi

passed=false
if $ok_up && $ok_both && $ok_fast && $ok_again; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"site-up","ok":%s,"message":"%s"},' "$ok_up" "$msg_up"
printf '{"id":"both-servers","ok":%s,"message":"%s"},' "$ok_both" "$msg_both"
printf '{"id":"home-fast","ok":%s,"message":"%s"},' "$ok_fast" "$msg_fast"
printf '{"id":"survives-repeat","ok":%s,"message":"%s"}' "$ok_again" "$msg_again"
printf ']}\n'
