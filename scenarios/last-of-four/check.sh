#!/bin/sh
# SECRET grader. Result, not method:
#   1-2. each of the four replicas answers an internal name and a fresh external name when asked directly;
#   3.   each replica resolves external names on its own: a whoami name answers with the address the query reached the
#        authoritative server from, and it must be the replica's own address (not a sibling, not the public resolver);
#   4.   a rebuild keeps it that way: the config that dns-rebuild would render now is started as a throwaway instance
#        on a spare port and must behave the same, and the config on disk must be the one a rebuild renders;
#   5-6. the issuer and the monitoring agent work with the config that is on the host, and every address they use
#        came from the cluster (no static pins, no foreign resolver).
# Addresses, names and expected answers are hard-coded: nothing is read from the files the player can edit, except
# where the file itself is what is being checked. Throwaway instances and the temp directory are removed on exit.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
INTERNAL=db-primary.core.internal
INTERNAL_ADDR=10.20.0.11
NONCE="g$$t$(date +%s)"

T=$(mktemp -d /tmp/grader.XXXXXX 2>/dev/null) || { T=/tmp/grader.$$; mkdir -p "$T"; }
tmp_pids=""
cleanup() {
  for p in $tmp_pids; do kill "$p" 2>/dev/null; done
  [ -n "$tmp_pids" ] && wait 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 1' TERM INT

# first A record of an answer, or nothing (SERVFAIL, timeout, no data)
ask() { dig +short +time=2 +tries=1 -p "$2" "@$1" "$3" A </dev/null 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1; }
site_addr() { python3 -c 'import sys, zlib
print("198.51.100.%d" % (1 + zlib.crc32(sys.argv[1].lower().encode()) % 250))' "$1." </dev/null 2>/dev/null; }

# probe one resolver: internal name, a fresh external name, who asked the authoritative server. Writes "i e w" flags.
probe() {  # addr port tag outfile
  i=0; e=0; w=0
  [ "$(ask "$1" "$2" "$INTERNAL")" = "$INTERNAL_ADDR" ] && i=1
  name="$NONCE-$3.sites.example"
  want=$(site_addr "$name")
  got=$(ask "$1" "$2" "$name")
  if [ -n "$want" ] && [ "$got" = "$want" ]; then
    e=1
    [ "$(ask "$1" "$2" "$NONCE-$3.whoami.probe.example")" = "$1" ] && w=1
  fi
  echo "$i $e $w" > "$4"
}

# the clients, with the config that is on the host; both in the background, they are slow when DNS is broken
python3 /opt/issuer/issuer.py --check > "$T/issuer.json" 2>/dev/null </dev/null &
pid_issuer=$!
python3 /opt/mon-agent/mon_agent.py --check > "$T/agent.json" 2>/dev/null </dev/null &
pid_agent=$!

# 1-3. the running replicas; a replica that was restarted a moment ago gets a second attempt
round=0
while [ $round -lt 2 ]; do
  pids=""
  for n in 1 2 3 4; do
    if [ "$(cat "$T/run$n" 2>/dev/null)" != "1 1 1" ]; then
      probe "127.0.0.2$n" 53 "r$round-ns$n" "$T/run$n" &
      pids="$pids $!"
    fi
  done
  [ -n "$pids" ] || break
  for p in $pids; do wait "$p"; done
  round=$((round + 1))
  [ $round -lt 2 ] && sleep 1
done
no_int=""; no_ext=""; not_self=""; answering=0
for n in 1 2 3 4; do
  set -- $(cat "$T/run$n" 2>/dev/null)
  [ "${1:-0}" = 1 ] || no_int="$no_int ns$n"
  if [ "${2:-0}" = 1 ]; then
    answering=$((answering + 1))
    [ "${3:-0}" = 1 ] || not_self="$not_self ns$n"
  else
    no_ext="$no_ext ns$n"
  fi
done

ok_int=false; msg_int="внутренние имена не разрешают:$no_int"
[ -z "$no_int" ] && { ok_int=true; msg_int="все четыре реплики отвечают на внутренние имена"; }
ok_ext=false; msg_ext="на внешние имена не отвечают:$no_ext"
[ -z "$no_ext" ] && { ok_ext=true; msg_ext="все четыре реплики отвечают на внешние имена"; }
ok_self=false
if [ $answering -eq 0 ]; then msg_self="проверка не выполнялась: ни одна реплика не отвечает на внешние имена"
elif [ -n "$not_self" ]; then msg_self="внешние имена за эти реплики разрешает другой сервер:$not_self"
elif [ -n "$no_ext" ]; then msg_self="проверка выполнена не для всех реплик: часть не отвечает на внешние имена"
else ok_self=true; msg_self="каждая реплика разрешает внешние имена сама"
fi

# 4. what a rebuild would produce now
ok_rebuild=false; msg_rebuild="проверка не выполнялась: сначала должны заработать сами реплики"
if $ok_int && $ok_ext && $ok_self; then
  no_render=""; drift=""; bad=""
  for n in 1 2 3 4; do
    r="ns$n"
    if ! dns-rebuild --dry-run "$r" > "$T/$r.rendered" 2>/dev/null </dev/null || [ ! -s "$T/$r.rendered" ]; then
      no_render="$no_render $r"; continue
    fi
    cmp -s "$T/$r.rendered" "/etc/dns-cluster/$r/unbound.conf" || drift="$drift $r"
    # a throwaway instance of the rendered config: same address, a spare port, no control socket, nothing written
    {
      cat "$T/$r.rendered"
      printf '\nserver:\n    port: %s\n    so-reuseport: no\n    pidfile: ""\n    use-syslog: no\n    logfile: ""\n    verbosity: 0\nremote-control:\n    control-enable: no\n' "$((5390 + n))"
    } > "$T/$r.conf"
    timeout -s KILL 20 unbound -d -c "$T/$r.conf" >/dev/null 2>&1 </dev/null &
    tmp_pids="$tmp_pids $!"
  done
  for n in 1 2 3 4; do
    [ -s "$T/ns$n.conf" ] || continue
    port=$((5390 + n)); i=0
    while [ $i -lt 20 ] && [ "$(ask "127.0.0.2$n" "$port" "$INTERNAL")" != "$INTERNAL_ADDR" ]; do
      i=$((i + 1)); sleep 0.25
    done
    probe "127.0.0.2$n" "$port" "b-ns$n" "$T/built$n"
    [ "$(cat "$T/built$n" 2>/dev/null)" = "1 1 1" ] || bad="$bad ns$n"
  done
  if [ -n "$no_render" ]; then msg_rebuild="dns-rebuild не собирает конфигурацию для:$no_render"
  elif [ -n "$bad" ]; then msg_rebuild="реплика, собранная пересборкой заново, не разрешает сама внутренние и внешние имена:$bad"
  elif [ -n "$drift" ]; then msg_rebuild="конфигурация на диске не совпадает с той, что собирает dns-rebuild:$drift"
  else ok_rebuild=true; msg_rebuild="пересборка любой реплики даёт рабочий резолвер, конфигурация на диске совпадает с собранной"
  fi
fi

# 5-6. the clients
wait "$pid_issuer" 2>/dev/null
wait "$pid_agent" 2>/dev/null
running() {  # pidfile, script path
  p=$(cat "$1" 2>/dev/null)
  [ -n "$p" ] && tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -qF "$2"
}
verdict() {  # file with the JSON of --check; prints: ok | fail <step> | foreign <names> | bad
  python3 -c 'import json, sys
cluster = {"127.0.0.21", "127.0.0.22", "127.0.0.23", "127.0.0.24"}
try:
    d = json.load(open(sys.argv[1]))
    steps = d["steps"]
except Exception:
    print("bad")
    sys.exit()
if not d.get("ok"):
    step = "".join(c for c in str(d.get("error", "")).split(":")[0] if c.isalnum() or c in " -")
    print("fail", step.replace("step ", "").strip() or "?")
    sys.exit()
foreign = sorted({s["name"] for s in steps if str(s["via"]).replace("@53", "") not in cluster})
foreign = [n for n in foreign if all(c.isalnum() or c in ".-" for c in n)]
print("foreign " + ", ".join(foreign) if foreign else "ok")' "$1" </dev/null 2>/dev/null
}

ok_issuer=false
v=$(verdict "$T/issuer.json")
case "$v" in
  ok) if running /run/issuer.pid /opt/issuer/issuer.py; then ok_issuer=true; msg_issuer="выпуск проходит, все адреса получены от кластера"; else msg_issuer="сервис issuer не запущен"; fi ;;
  fail*) msg_issuer="выпуск не проходит: заказ останавливается на шаге ${v#fail }" ;;
  foreign*) msg_issuer="issuer получает адреса не от кластера: ${v#foreign }" ;;
  *) msg_issuer="issuer не смог выполнить пробный заказ" ;;
esac
ok_mon=false
v=$(verdict "$T/agent.json")
case "$v" in
  ok) if running /run/mon-agent.pid /opt/mon-agent/mon_agent.py; then ok_mon=true; msg_mon="агент мониторинга доставляет метрики, все адреса получены от кластера"; else msg_mon="сервис mon-agent не запущен"; fi ;;
  fail*) msg_mon="агент мониторинга не может доставить метрики" ;;
  foreign*) msg_mon="mon-agent получает адреса не от кластера: ${v#foreign }" ;;
  *) msg_mon="mon-agent не смог выполнить пробный цикл" ;;
esac

passed=false
if $ok_int && $ok_ext && $ok_self && $ok_rebuild && $ok_issuer && $ok_mon; then passed=true; fi
printf '{"passed":%s,"criteria":[' "$passed"
printf '{"id":"internal-names","ok":%s,"message":"%s"},' "$ok_int" "$msg_int"
printf '{"id":"external-names","ok":%s,"message":"%s"},' "$ok_ext" "$msg_ext"
printf '{"id":"resolves-itself","ok":%s,"message":"%s"},' "$ok_self" "$msg_self"
printf '{"id":"rebuild-safe","ok":%s,"message":"%s"},' "$ok_rebuild" "$msg_rebuild"
printf '{"id":"issuer-works","ok":%s,"message":"%s"},' "$ok_issuer" "$msg_issuer"
printf '{"id":"monitoring-works","ok":%s,"message":"%s"}' "$ok_mon" "$msg_mon"
printf ']}\n'
