#!/bin/sh
# SECRET. A visitor posts a question whose code block has a comment line with 20 000 spaces in the middle. The home page
# renders the newest questions and trims every line with a backtracking regex: on that line it takes seconds. The load
# balancer's health check is the home page, so both servers leave the rotation and every URL answers 503.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DB=/var/lib/forum/forum.db

i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 120 ]; do i=$((i + 1)); sleep 0.5; done
[ -e /run/.boot-complete ] || { echo "break: FAILED, the container init did not finish in 60 s" >&2; exit 1; }

# the site must be healthy before it is broken
i=0; code=000
while [ $i -lt 40 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/ </dev/null 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "200" ] || { echo "break: FAILED, the site did not come up healthy (HTTP $code)" >&2; exit 1; }

python3 -c 'import sqlite3, sys, time
body = "\n".join([
    "После обновления библиотеки обработчик очереди падает. Минимальный пример:",
    "    def handle(msg):",
    "        payload = decode(msg)",
    "        # TODO" + " " * 20000 + "проверить кодировку",
    "        return process(payload)",
    "Ошибка воспроизводится не всегда. В какую сторону смотреть?",
])
c = sqlite3.connect(sys.argv[1], timeout=10)
c.execute("INSERT INTO questions (title, body, author, created_at) VALUES (?, ?, ?, ?)",
          ("Обработчик очереди падает после обновления библиотеки", body, "newbie_dev", int(time.time())))
c.commit()' "$DB" </dev/null || { echo "break: FAILED, could not insert the post" >&2; exit 1; }
chown forum:forum "$DB"

# two failed checks three seconds apart take a server out; wait until the balancer has nobody left
i=0; code=000
while [ $i -lt 60 ]; do
  code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1/questions/1 </dev/null 2>/dev/null || echo 000)
  [ "$code" = "503" ] && break
  i=$((i + 1)); sleep 1
done
[ "$code" = "503" ] || { echo "break: FAILED, the balancer still answers $code for an ordinary page" >&2; exit 1; }
echo "break: done (both servers are out of rotation, every URL answers 503)"
