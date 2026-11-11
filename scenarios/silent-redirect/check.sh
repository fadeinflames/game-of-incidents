#!/bin/sh
# SECRET grader. Result, not method:
#   every site of the list answers 200 from its own application, every site name is in the configuration nginx reads,
#   nginx runs with a valid configuration, unknown names (and the closed beta site) still go to the main site.
# The list of sites and ports is hard-coded: nothing is read from files the player can edit.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
MAIN=www.polka.example
CLOSED=beta.polka.example
SITES="www.polka.example:9001 brn.polka.example:9101 chel.polka.example:9102 ekb.polka.example:9103
irk.polka.example:9104 izh.polka.example:9105 khv.polka.example:9106 krd.polka.example:9107 krsk.polka.example:9108
kzn.polka.example:9109 msk.polka.example:9110 nn.polka.example:9111 nsk.polka.example:9112 omsk.polka.example:9113
prm.polka.example:9114 rnd.polka.example:9115 sam.polka.example:9116 spb.polka.example:9117 srt.polka.example:9118
tlt.polka.example:9119 tmn.polka.example:9120 ufa.polka.example:9121 vlg.polka.example:9122 vrn.polka.example:9123
yar.polka.example:9124 api.polka.example:9201 auth.polka.example:9202 blog.polka.example:9203
cabinet.polka.example:9204 docs.polka.example:9205 help.polka.example:9206 img.polka.example:9207
jobs.polka.example:9208 m.polka.example:9209 partners.polka.example:9210 pay.polka.example:9211
promo.polka.example:9212 sale.polka.example:9213 search.polka.example:9214 static.polka.example:9215
status.polka.example:9216"

ok_nginx=false; msg_nginx="nginx не запущен"
ok_conf=false;  msg_conf="nginx -t сообщает об ошибке в конфигурации"
ok_sites=false; msg_sites="сайты не отвечают"
ok_names=false; msg_names="в конфигурации nginx нет ожидаемых имён сайтов"
ok_rest=false;  msg_rest="запрос с неизвестным именем сайта не уходит на главный сайт"

if pgrep -x nginx >/dev/null 2>&1; then ok_nginx=true; msg_nginx="nginx запущен"; fi
if nginx -t >/dev/null 2>&1; then ok_conf=true; msg_conf="конфигурация nginx проходит проверку"; fi

# 1. every site: 200, the answer is signed by the site's own application, and that application confirms it received
#    this very request (a unique mark in the query string). One more attempt after a pause: a reload may be in progress.
run="g$$t$(date +%s)"
attempts=2
$ok_nginx || attempts=1
total=0; good=0
for pair in $SITES; do
  host=${pair%%:*}; port=${pair##*:}
  total=$((total + 1)); try=0
  while [ $try -lt $attempts ]; do
    mark="${run}n${total}a${try}"
    out=$(curl -q -s --max-time 3 -H "Host: $host" -w 'HTTP_CODE=%{http_code}' "http://127.0.0.1/?check=$mark" </dev/null 2>/dev/null)
    if [ "${out##*HTTP_CODE=}" = "200" ] && printf '%s\n' "$out" | grep -qxF "site=$host"; then
      seen=$(curl -q -s --max-time 3 "http://127.0.0.1:$port/__seen?token=$mark" </dev/null 2>/dev/null)
      if [ "$seen" = "yes" ]; then good=$((good + 1)); break; fi
    fi
    try=$((try + 1))
    [ $try -lt $attempts ] && sleep 0.5
  done
done
if [ $good -eq $total ]; then ok_sites=true; msg_sites="каждый сайт отвечает 200 от своего приложения ($good из $total)"
else msg_sites="от своего приложения с кодом 200 отвечают $good из $total сайтов"
fi

# 2. the configuration nginx reads from disk names every site
names=$(nginx -T 2>/dev/null | awk '$1 == "server_name" { for (i = 2; i <= NF; i++) { gsub(/;/, "", $i); if ($i != "") print $i } }')
known=0
for pair in $SITES; do
  if printf '%s\n' "$names" | grep -qxF "${pair%%:*}"; then known=$((known + 1)); fi
done
if [ $known -eq $total ]; then ok_names=true; msg_names="в конфигурации nginx есть все имена сайтов ($known из $total)"
else msg_names="в конфигурации nginx есть $known из $total имён сайтов"
fi

# 3. the catch-all rule stays: an unknown name and the closed site are redirected to the main site
where() {
  curl -q -s -o /dev/null --max-time 3 -H "Host: $1" -w '%{http_code} %{redirect_url}' http://127.0.0.1/old/link </dev/null 2>/dev/null
}
to_main() {
  case "$1" in
    30[1278]" http://$MAIN"|30[1278]" http://$MAIN/"*|30[1278]" https://$MAIN"|30[1278]" https://$MAIN/"*) return 0 ;;
  esac
  return 1
}
unknown=$(where "no-such-site-$$.polka.example")
closed=$(where "$CLOSED")
if ! to_main "$unknown"; then msg_rest="запрос с неизвестным именем сайта не уходит на главный сайт (HTTP ${unknown%% *})"
elif ! to_main "$closed"; then msg_rest="закрытый сайт $CLOSED снова обслуживается отдельно (HTTP ${closed%% *}), он должен оставаться выключенным"
else ok_rest=true; msg_rest="неизвестные имена и закрытый сайт по-прежнему уходят на главный сайт"
fi

passed=false
if $ok_nginx && $ok_conf && $ok_sites && $ok_names && $ok_rest; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"nginx-running","ok":%s,"message":"%s"},' "$ok_nginx" "$msg_nginx"
printf '{"id":"nginx-config-valid","ok":%s,"message":"%s"},' "$ok_conf" "$msg_conf"
printf '{"id":"sites-answer","ok":%s,"message":"%s"},' "$ok_sites" "$msg_sites"
printf '{"id":"names-in-config","ok":%s,"message":"%s"},' "$ok_names" "$msg_names"
printf '{"id":"catch-all-kept","ok":%s,"message":"%s"}' "$ok_rest" "$msg_rest"
printf ']}\n'
