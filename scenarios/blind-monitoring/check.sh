#!/bin/sh
# SECRET grader: samples reach the central gateway again, TLS is still verified (no insecure_skip_verify), the trust
# store holds CA #2 (the one the gateway certificate is issued by), the gateway itself was not rolled back, Prometheus
# and the app are Ready. The reference CA comes from the gateway image, not from the ConfigMap/annotations the player can edit.
ok_flow=false;  msg_flow="метрики не доходят до центрального шлюза (нет записей за последние 60 с)"
ok_tls=false;   msg_tls="TLS-проверка отключена (insecure_skip_verify): это не починка, а слепое доверие"
ok_ca=false;    msg_ca="в trust store Prometheus (monitoring/remote-write-ca) нет текущего CA #2, которым выпущен сертификат шлюза"
ok_gw=false;    msg_gw="не удалось прочитать статус шлюза"
ok_prom=false;  msg_prom="prometheus не Ready"
ok_app=false;   msg_app="checkout не в 2 из 2 Ready"

# "age ca_active"; a few attempts, because right after the fix the first batch may still be on its way
age=9999; ca_active=""
n=0
while [ $n -lt 4 ]; do
  st=$(kubectl -n monitoring exec deploy/metrics-gateway -- python3 -c 'import json,urllib.request; d=json.load(urllib.request.urlopen("http://127.0.0.1:9090/status",timeout=3)); print(d["last_write_age_s"] if d["last_write_age_s"] is not None else 9999, d["ca_active"])' 2>/dev/null | tr -d '\r')
  case "$st" in
    *" "*) age=${st%% *}; ca_active=${st##* } ;;
  esac
  [ "$age" -le 60 ] && break
  n=$((n + 1))
  [ $n -lt 4 ] && sleep 5
done
[ "$age" -le 60 ] && { ok_flow=true; msg_flow="метрики доходят до шлюза (последняя запись ${age} с назад)"; }

if [ "$ca_active" = "2" ]; then
  ok_gw=true; msg_gw="шлюз по-прежнему на новом CA #2"
elif [ -n "$ca_active" ]; then
  msg_gw="шлюз откатили на CA #$ca_active: ротацию и шлюз менять нельзя, чинится доверие на стороне Prometheus"
fi

cfg=$(kubectl -n monitoring get configmap prometheus-config -o jsonpath='{.data.prometheus\.yml}' 2>/dev/null)
live=$(kubectl -n monitoring exec deploy/prometheus -- cat /etc/prometheus/prometheus.yml 2>/dev/null)
running=$(kubectl -n monitoring exec deploy/prometheus -- wget -qO- http://127.0.0.1:9090/api/v1/status/config 2>/dev/null)
if ! printf '%s\n%s\n%s\n' "$cfg" "$live" "$running" | grep -v '^[[:space:]]*#' | grep -Eiq "insecure_skip_verify[[:space:]]*:[[:space:]]*['\"]?(true|yes|on|y)([^[:alnum:]_]|\$)"; then ok_tls=true; msg_tls="TLS-проверка remote_write включена"; fi

# the Secret may hold a bundle (old + new CA); what matters is that the PEM of CA #2 is in it
want=$(kubectl -n monitoring exec deploy/metrics-gateway -- cat /certs/ca2/ca.crt 2>/dev/null | tr -d '\r' | sed '/^$/d')
have=$(kubectl -n monitoring get secret remote-write-ca -o jsonpath='{.data.ca\.crt}' 2>/dev/null | base64 -d 2>/dev/null | tr -d '\r' | sed '/^$/d')
case "$have" in
  *"$want"*) [ -n "$want" ] && { ok_ca=true; msg_ca="trust store Prometheus содержит текущий CA #2"; } ;;
esac

pready=$(kubectl -n monitoring get deploy prometheus -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${pready:-0}" = "1" ] && { ok_prom=true; msg_prom="prometheus Ready"; }
aready=$(kubectl -n shop get deploy checkout -o jsonpath='{.status.readyReplicas}' 2>/dev/null)
[ "${aready:-0}" = "2" ] && { ok_app=true; msg_app="checkout: 2 из 2 Ready"; }

passed=false
if $ok_flow && $ok_tls && $ok_ca && $ok_gw && $ok_prom && $ok_app; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"samples-flow","ok":%s,"message":"%s"},' "$ok_flow" "$msg_flow"
printf '{"id":"tls-verified","ok":%s,"message":"%s"},' "$ok_tls" "$msg_tls"
printf '{"id":"trust-store-current","ok":%s,"message":"%s"},' "$ok_ca" "$msg_ca"
printf '{"id":"gateway-unchanged","ok":%s,"message":"%s"},' "$ok_gw" "$msg_gw"
printf '{"id":"prometheus-ready","ok":%s,"message":"%s"},' "$ok_prom" "$msg_prom"
printf '{"id":"app-ready","ok":%s,"message":"%s"}' "$ok_app" "$msg_app"
printf ']}\n'
