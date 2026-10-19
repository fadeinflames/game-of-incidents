#!/bin/sh
# SECRET grader. Runs as root via stdin exec (ADR-0004). POSIX sh only. Prints one JSON object to stdout.
# Criteria check the RESULT, not the method.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

ok_nginx=false;  msg_nginx="nginx не запущен"
ok_conf=false;   msg_conf="nginx -t сообщает об ошибке в конфигурации"
ok_http=false;   msg_http="GET http://127.0.0.1/ не вернул 200"
ok_body=false;   msg_body="приложение app не подтвердило запрос на / (его нет в /var/log/app/app.log): ответ даёт не оно"

if /usr/bin/pgrep -x nginx >/dev/null 2>&1; then ok_nginx=true; msg_nginx="nginx запущен"; fi
if /usr/sbin/nginx -t >/dev/null 2>&1; then ok_conf=true; msg_conf="конфигурация nginx валидна"; fi

# nginx graceful reload: old workers may answer for ~1-2 s after `service nginx reload`; give the RESULT time to settle.
# Every request carries a unique query string: "answered by the app" means the app itself logged that exact request
# (a stub like `return 200 "OK from app"` in nginx never reaches it).
code=000; i=0; token=""
while [ $i -lt 5 ]; do
  token="wom-$(date +%s)-$$-$i"
  code=$(/usr/bin/curl -q -s -o /tmp/.wom_check_body -w '%{http_code}' --max-time 5 "http://127.0.0.1/?check=$token" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
if [ "$code" = "200" ]; then ok_http=true; msg_http="GET / → 200"; else msg_http="GET / → $code"; fi
if [ "$code" = "200" ] && [ -f /tmp/.wom_check_body ] && /usr/bin/grep -q "OK from app" /tmp/.wom_check_body 2>/dev/null; then
  # the app writes its request log to stderr, which the init script appends to app.log; give the line a moment to land
  i=0
  while [ $i -lt 4 ]; do
    if /usr/bin/grep -qF "check=$token " /var/log/app/app.log 2>/dev/null; then
      ok_body=true; msg_body="ответ приходит от приложения app"
      break
    fi
    i=$((i + 1)); sleep 0.5
  done
fi
rm -f /tmp/.wom_check_body

passed=false
if $ok_nginx && $ok_conf && $ok_http && $ok_body; then passed=true; fi

printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"nginx-running","ok":%s,"message":"%s"},' "$ok_nginx" "$msg_nginx"
printf '{"id":"nginx-config-valid","ok":%s,"message":"%s"},' "$ok_conf" "$msg_conf"
printf '{"id":"http-200","ok":%s,"message":"%s"},' "$ok_http" "$msg_http"
printf '{"id":"body-from-app","ok":%s,"message":"%s"}' "$ok_body" "$msg_body"
printf ']}\n'
