#!/bin/sh
# SECRET grader. Result, not method. Over one 12-second window, with advisory jobs waiting on both fan-out queues:
#   user actions through the API succeed, the applications together keep at most half of the database connections,
#   both fan-out queues are being worked off, the global parameters of the database server are what the DBA team set,
#   and every job of every published advisory is either done (an alert exists) or still in its queue.
# "With jobs waiting on both queues" is what makes the result hold for the next advisory too: a queue that holds
# fewer than 150 jobs gets 150 jobs of a probe advisory for the window; the probe is removed afterwards.
# Nothing is read from files the player can edit: socket, ports, queue names and thresholds are fixed here.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
python3 -I - <<'PY'
import collections
import json
import os
import subprocess
import time
import urllib.error
import urllib.request

import redis

SOCK = "/run/mysqld/mysqld.sock"
API = "http://127.0.0.1:8080"
FANOUT = ["secalerts.advisory_fanout", "secalerts.advisory_fanout_bulk"]
INFLIGHT = "jobrunner:inflight"
MAX_CONNECTIONS = 40          # what the DBA team configured
HEADROOM = 20                 # the brief: all applications together hold at most 20 connections
WINDOW = 12.0
PROBE_BELOW = 150             # a fan-out queue with fewer jobs than this gets probe jobs
PROBE_JOBS = 150
CANARY = 1                    # the alert the grader acts on; the users of the stand never touch it
END = "__wom_end__"

crit = collections.OrderedDict([
    ("user-writes", [False, "действия пользователей с алертами через API не проверены"]),
    ("db-headroom", [False, "запас соединений базы не проверен"]),
    ("db-params", [False, "глобальные параметры сервера базы не проверены"]),
    ("fanout-running", [False, "обработка рассылки бюллетеней не проверена"]),
    ("nothing-lost", [False, "сохранность заданий рассылки не проверена"]),
])


def emit():
    print(json.dumps({"passed": all(v[0] for v in crit.values()),
                      "criteria": [{"id": k, "ok": v[0], "message": v[1]} for k, v in crit.items()]}, ensure_ascii=False))


class DB:
    """One root session over the socket, kept open for the whole check (the mysql client, not a config file)."""

    def __init__(self):
        self.p = subprocess.Popen(
            ["mysql", "--no-defaults", "--protocol=socket", "-S", SOCK, "-u", "root", "-N", "-B", "--unbuffered", "--force",
             "--connect-timeout=5", "secalerts"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def q(self, sql):
        self.p.stdin.write(sql.rstrip().rstrip(";") + ";\nSELECT '%s';\n" % END)
        self.p.stdin.flush()
        rows = []
        while True:
            line = self.p.stdout.readline()
            if line == "":
                raise RuntimeError("the database session is closed")
            line = line.rstrip("\n")
            if line == END:
                return rows
            rows.append(line.split("\t"))

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def act(action):
    req = urllib.request.Request("%s/alerts/%d/%s" % (API, CANARY, action), data=b"", method="POST")
    try:
        with OPENER.open(req, timeout=5) as resp:
            resp.read()
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def main():
    waited = 0
    while not os.path.exists("/run/.boot-complete") and waited < 60:
        time.sleep(1)
        waited += 1
    if not os.path.exists("/run/.boot-complete"):
        for v in crit.values():
            v[1] = "стенд ещё запускается, повтори проверку через минуту"
        return

    db = None
    for attempt in range(3):
        try:
            db = DB()
            db.q("SELECT 1")
            break
        except Exception:
            if db is not None:
                db.close()
            db = None
            time.sleep(1)
    if db is None:
        for v in crit.values():
            v[1] = "проверка не смогла открыть служебное соединение с MariaDB (root через сокет): закрой свои сессии mysql и повтори"
        return
    r = redis.Redis(host="127.0.0.1", port=6379, socket_timeout=10, socket_connect_timeout=3, decode_responses=True)

    probe_id = None
    probe_jobs = {}
    canary_before = None
    try:
        # the global parameters of the server
        try:
            row = db.q("SELECT @@global.max_connections, @@global.max_user_connections")[0]
            if int(row[0]) != MAX_CONNECTIONS:
                crit["db-params"][1] = "глобальный параметр сервера базы изменён: max_connections = %s, у DBA было %d" % (row[0], MAX_CONNECTIONS)
            elif int(row[1]) != 0:
                crit["db-params"][1] = "глобальный параметр сервера базы изменён: max_user_connections = %s" % row[1]
            else:
                crit["db-params"] = [True, "глобальные параметры сервера базы не тронуты (max_connections = %d)" % MAX_CONNECTIONS]
        except Exception:
            crit["db-params"][1] = "не удалось прочитать параметры сервера базы"

        try:
            canary_before = db.q("SELECT state FROM alerts WHERE id = %d" % CANARY)[0][0]
        except Exception:
            canary_before = None

        # a change that was applied a moment ago needs a few seconds: the jobs that were already running finish first
        conn_sql = ("SELECT COUNT(*) FROM information_schema.processlist "
                    "WHERE id <> CONNECTION_ID() AND user NOT IN ('root', 'system user', 'event_scheduler')")
        settle = 0
        while settle < 16 and int(db.q(conn_sql)[0][0]) > HEADROOM:
            time.sleep(0.5)
            settle += 1

        # jobs must be waiting on both fan-out queues during the window
        redis_ok = True
        try:
            short = [q for q in FANOUT if r.llen(q) < PROBE_BELOW]
        except Exception:
            redis_ok = False
            short = []
        if short:
            try:
                db.q("INSERT INTO advisories (package, ecosystem, severity, summary, affected_repos, published_at) "
                     "VALUES ('pipeline-selfcheck', 'npm', 'low', 'Selfcheck of the advisory pipeline', 0, NOW())")
                probe_id = int(db.q("SELECT LAST_INSERT_ID()")[0][0])
                for q in short:
                    base = 4000000 if q == FANOUT[0] else 4000001
                    probe_jobs[q] = [json.dumps({"jid": os.urandom(6).hex(), "class": "AdvisoryRepoMatch", "queue": q,
                                                 "args": {"advisory": probe_id, "repo": base + 4 * n}}, separators=(",", ":"))
                                     for n in range(PROBE_JOBS)]
            except Exception:
                probe_id = None
                probe_jobs = {}
        top = int(db.q("SELECT COALESCE(MAX(id), 0) FROM alerts")[0][0])
        try:
            for q, jobs in probe_jobs.items():
                r.lpush(q, *jobs)
        except Exception:
            redis_ok = False

        # the window: connections of the applications four times a second, a user action twice a second
        peak = 0
        codes = []
        seen_in_db = None
        step = 0
        stop_at = time.monotonic() + WINDOW
        while time.monotonic() < stop_at:
            peak = max(peak, int(db.q(conn_sql)[0][0]))
            if step % 2 == 0:
                action = "dismiss" if (step // 2) % 2 == 0 else "reopen"
                code = act(action)
                codes.append(code)
                if code == 200 and action == "dismiss" and seen_in_db is None:
                    seen_in_db = db.q("SELECT state FROM alerts WHERE id = %d" % CANARY)[0][0] == "dismissed"
            step += 1
            time.sleep(0.25)

        bad = [c for c in codes if c != 200]
        if bad:
            last = bad[-1]
            crit["user-writes"][1] = "из %d действий с алертами через API не прошли %d (последний ответ: %s)" % (
                len(codes), len(bad), "HTTP %d" % last if last else "нет ответа")
        elif not seen_in_db:
            crit["user-writes"][1] = "API отвечает 200, но действие не дошло до базы secalerts"
        else:
            crit["user-writes"] = [True, "действия с алертами проходят: %d из %d за %d секунд" % (len(codes), len(codes), WINDOW)]

        if peak > HEADROOM:
            crit["db-headroom"][1] = "приложения держат до %d соединений с базой: допустимо не больше %d" % (peak, HEADROOM)
        elif not redis_ok:
            crit["db-headroom"][1] = "Redis с очередями недоступен: запас соединений под нагрузкой рассылки проверить не удалось"
        else:
            crit["db-headroom"] = [True, "пока в обеих очередях рассылки есть задания, приложения держат не больше %d соединений с базой из %d" % (peak, MAX_CONNECTIONS)]

        # both queues are being worked off: alerts appeared for repositories of each of them
        row = db.q("SELECT COALESCE(SUM(repo_id %% 4 = 0), 0), COALESCE(SUM(repo_id %% 4 <> 0), 0) FROM alerts WHERE id > %d" % top)[0]
        made = [int(row[0]), int(row[1])]
        if not redis_ok:
            crit["fanout-running"][1] = "Redis с очередями недоступен: рассылка бюллетеней стоит"
        elif made[0] and made[1]:
            crit["fanout-running"] = [True, "рассылка бюллетеней идёт, обе очереди разбираются: алертов за %d секунд создано %d" % (WINDOW, made[0] + made[1])]
        elif made[0] + made[1] == 0:
            crit["fanout-running"][1] = "рассылка бюллетеней стоит: за %d секунд не создано ни одного алерта, хотя задания в очередях есть" % WINDOW
        else:
            idle = FANOUT[1] if made[0] else FANOUT[0]
            crit["fanout-running"][1] = "очередь %s не разбирается: за %d секунд по её заданиям не создано ни одного алерта" % (idle, WINDOW)

        # nothing was thrown away: published advisories first, then what is still queued, then what is done
        try:
            published = {int(a): int(n) for a, n in db.q("SELECT id, affected_repos FROM advisories WHERE fanned_out_at IS NOT NULL")}
            pipe = r.pipeline(transaction=True)
            for key in FANOUT + [INFLIGHT]:
                pipe.lrange(key, 0, -1)
            waiting = collections.defaultdict(set)
            for chunk in pipe.execute():
                for raw in chunk:
                    try:
                        job = json.loads(raw)
                        if job["class"] == "AdvisoryRepoMatch":
                            waiting[int(job["args"]["advisory"])].add(int(job["args"]["repo"]))
                    except Exception:
                        continue
            done = {int(a): int(n) for a, n in db.q("SELECT advisory_id, COUNT(*) FROM alerts GROUP BY advisory_id")}
            missing = sum(max(0, n - done.get(a, 0) - len(waiting.get(a, ()))) for a, n in published.items())
            queued = sum(len(s) for a, s in waiting.items() if a != probe_id)
            if not published:
                crit["nothing-lost"][1] = "таблица advisories пуста: опубликованные бюллетени пропали"
            elif missing:
                crit["nothing-lost"][1] = "%d заданий рассылки нет ни в своих очередях, ни среди созданных алертов: эти репозитории алерт не получат" % missing
            else:
                crit["nothing-lost"] = [True, "задания рассылки на месте: %d ждут в очередях, остальные выполнены" % queued]
        except Exception:
            crit["nothing-lost"][1] = "не удалось сверить очереди Redis с таблицей алертов"
    finally:
        # the probe advisory leaves nothing behind
        try:
            if probe_jobs:
                pipe = r.pipeline(transaction=False)
                for q, jobs in probe_jobs.items():
                    for raw in jobs:
                        pipe.lrem(q, 0, raw)
                pipe.execute()
            if probe_id is not None:
                marker = '"advisory":%d,' % probe_id
                for attempt in range(36):
                    if not any(marker in raw for raw in r.lrange(INFLIGHT, 0, -1)):
                        break
                    time.sleep(0.25)
        except Exception:
            pass
        try:
            if probe_id is not None:
                db.q("DELETE FROM alerts WHERE advisory_id = %d" % probe_id)
                db.q("DELETE FROM advisories WHERE id = %d" % probe_id)
            if canary_before in ("open", "dismissed", "resolved"):
                db.q("UPDATE alerts SET state = '%s' WHERE id = %d AND state <> '%s'" % (canary_before, CANARY, canary_before))
        except Exception:
            pass
        db.close()


try:
    main()
except Exception:
    pass
emit()
PY
rc=$?
[ $rc -eq 0 ] || printf '{"passed":false,"criteria":[{"id":"grader","ok":false,"message":"проверка не смогла выполниться на этом стенде"}]}\n'
exit 0
