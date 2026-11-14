#!/bin/sh
# SECRET grader. Result, not method:
#   a token issued now validates at once and every time; tokens issued earlier validate; no issued token was deleted;
#   the migration is alive, in its first generation, without an error; the queue of changes it still has to apply
#   shrinks (or is empty); and what db-new holds is exactly db-old as of the position of the migration.
# Nothing is read from files the player can edit: sockets, table names and ranges are fixed here, and where tokend
# reads and writes is seen from what it does.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
python3 -I - <<'PY'
import hashlib
import json
import os
import subprocess
import time
import urllib.error
import urllib.request

LIVE_BASE = 231500            # ids above it are tokens issued while the stand runs
SERVICE = 300                 # ids 1..300: long-lived service tokens
API = "http://127.0.0.1:8080"
SOCK = {"old": "/run/mysqld/db-old.sock", "new": "/run/mysqld/db-new.sock"}
WINDOW = 8                    # seconds between the two looks at the queue of the migration
FRESH = 6                     # tokens issued by the grader, each validated three times at once and once more later

crit = {
    "fresh-tokens-valid": [False, "не удалось выдать и проверить токен через tokend"],
    "issued-tokens-valid": [False, "не удалось проверить ранее выданные токены"],
    "nothing-lost": [False, "не удалось прочитать таблицу токенов"],
    "migration-healthy": [False, "не удалось прочитать состояние переноса данных"],
    "migration-converging": [False, "не удалось прочитать очередь переноса данных"],
    "clusters-consistent": [False, "не удалось сравнить данные двух кластеров"],
}
ORDER = list(crit)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def emit():
    passed = all(crit[k][0] for k in ORDER)
    print(json.dumps({"passed": passed, "criteria": [{"id": k, "ok": crit[k][0], "message": crit[k][1]} for k in ORDER]},
                     ensure_ascii=False))


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception:
        return 0, {}


def sql(side, script):
    p = subprocess.run(["/usr/bin/mysql", "--no-defaults", "-N", "-B", "-S", SOCK[side], "tokens"], input=script,
                       capture_output=True, text=True, timeout=25)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip()[:200])
    return [line.split("\t") for line in p.stdout.splitlines()]


def position():
    """(applied seq, head seq of the change log)"""
    p = int(sql("new", "SELECT applied_seq FROM _tablemover_job WHERE job = 'tokens-move';")[0][0])
    h = int(sql("old", "SELECT COALESCE(MAX(seq), 0) FROM _tablemover_changes;")[0][0])
    return p, max(h, p)


def main():
    # a grader started while the container is still booting waits for the services
    for _ in range(60):
        if os.path.exists("/run/.boot-complete"):
            break
        time.sleep(0.5)

    # 1. tokens issued now: each one is validated at once, three times
    fresh = []
    bad = total = 0
    issue_code = 201
    for _ in range(FRESH):
        code, doc = http("POST", "/v1/tokens", {"integration": 7})
        if code != 201 or not doc.get("token"):
            issue_code = code
            continue
        fresh.append(doc["token"])
        for _ in range(3):
            total += 1
            if http("GET", "/v1/tokens/" + doc["token"])[0] != 200:
                bad += 1
    if len(fresh) < FRESH:
        crit["fresh-tokens-valid"][1] = "tokend не выдаёт токены: POST /v1/tokens ответил %d" % issue_code

    # 2. the queue of the migration, first look
    first = None
    try:
        first = position()
    except Exception:
        pass
    time.sleep(WINDOW)

    for token in fresh:
        total += 1
        if http("GET", "/v1/tokens/" + token)[0] != 200:
            bad += 1
    if len(fresh) == FRESH:
        if bad == 0:
            crit["fresh-tokens-valid"] = [True, "только что выданные токены проходят проверку: %d запросов из %d" % (total, total)]
        else:
            crit["fresh-tokens-valid"][1] = "только что выданные токены не проходят проверку: отказ на %d запросах из %d" % (bad, total)

    # 3. db-new: the state of the job and the table, in one snapshot (the applier commits both together)
    job = n_low = None
    n_rows = {}
    try:
        for row in sql("new", """
START TRANSACTION WITH CONSISTENT SNAPSHOT;
SELECT 'job', generation, phase, state, applied_seq, IF(last_error IS NULL OR last_error = '', 0, 1),
       COALESCE(TIMESTAMPDIFF(SECOND, heartbeat_at, NOW()), 999999) FROM _tablemover_job WHERE job = 'tokens-move';
SELECT 'low', COUNT(*) FROM install_tokens WHERE id <= %d;
SELECT 'row', id, token, expires_at > NOW() + INTERVAL 30 SECOND FROM install_tokens WHERE id > %d;
COMMIT;
""" % (LIVE_BASE, LIVE_BASE)):
            if row[0] == "job":
                job = {"generation": int(row[1]), "phase": row[2], "state": row[3], "applied": int(row[4]),
                       "error": row[5] == "1", "beat": int(row[6])}
            elif row[0] == "low":
                n_low = int(row[1])
            elif row[0] == "row":
                n_rows[int(row[1])] = (row[2], row[3] == "1")
    except Exception:
        job = None

    # 4. db-old: the table and what the change log still holds after that position
    old = None
    if job is not None and n_low is not None:
        try:
            old = {"rows": {}, "pend_ins": set(), "pend_del_high": set()}
            for row in sql("old", """
START TRANSACTION WITH CONSISTENT SNAPSHOT;
SELECT 'head', COALESCE(MAX(seq), 0) FROM _tablemover_changes;
SELECT 'low', COUNT(*) FROM install_tokens WHERE id <= %(base)d;
SELECT 'svc', COUNT(*) FROM install_tokens WHERE id <= %(svc)d;
SELECT 'row', id, token, expires_at > NOW() + INTERVAL 30 SECOND FROM install_tokens WHERE id > %(base)d;
SELECT 'pi', row_id FROM _tablemover_changes WHERE seq > %(p)d AND op = 'I';
SELECT 'pdl', COUNT(*) FROM _tablemover_changes WHERE seq > %(p)d AND op = 'D' AND row_id <= %(base)d;
SELECT 'pdh', row_id FROM _tablemover_changes WHERE seq > %(p)d AND op = 'D' AND row_id > %(base)d;
COMMIT;
""" % {"base": LIVE_BASE, "svc": SERVICE, "p": job["applied"]}):
                if row[0] in ("head", "low", "svc", "pdl"):
                    old[row[0]] = int(row[1])
                elif row[0] == "row":
                    old["rows"][int(row[1])] = (row[2], row[3] == "1")
                elif row[0] == "pi":
                    old["pend_ins"].add(int(row[1]))
                elif row[0] == "pdh":
                    old["pend_del_high"].add(int(row[1]))
            for key in ("head", "low", "svc", "pdl"):
                old[key]
        except Exception:
            old = None

    # 5. the migration itself
    if job is not None:
        if job["generation"] != 1 or job["phase"] != "tailing":
            crit["migration-healthy"][1] = "перенос данных начат заново: накопленная копия на db-new отброшена"
        elif job["state"] == "error" or job["error"]:
            crit["migration-healthy"][1] = "перенос данных остановился с ошибкой"
        elif job["state"] != "running" or job["beat"] > 15:
            crit["migration-healthy"][1] = "перенос данных не работает: изменения на db-new не применяются"
        elif first is not None and first[1] > first[0] and job["applied"] <= first[0]:
            crit["migration-healthy"][1] = "перенос данных не продвигается: за %d секунд не применено ни одного изменения" % WINDOW
        elif first is not None:
            crit["migration-healthy"] = [True, "перенос данных работает, ошибок нет"]

    if job is not None and old is not None and first is not None:
        before = first[1] - first[0]
        after = max(0, old["head"] - job["applied"])
        if after <= 30:
            crit["migration-converging"] = [True, "очередь переноса пуста или почти пуста (%d изменений)" % after]
        elif after <= before - 20:
            crit["migration-converging"] = [True, "очередь переноса сокращается: %d изменений, %d секунд назад было %d" % (after, WINDOW, before)]
        else:
            crit["migration-converging"][1] = ("перенос данных не приближается к завершению: в его очереди %d изменений, "
                                               "%d секунд назад было %d" % (after, WINDOW, before))

    if job is not None and old is not None:
        o_rows, pend_ins = old["rows"], old["pend_ins"]
        max_o = max(o_rows, default=LIVE_BASE)
        max_n = max(n_rows, default=LIVE_BASE)
        drained = job["applied"] >= old["head"]
        written_new = bool(fresh) and all(any(v[0] == t for v in n_rows.values()) for t in fresh) \
            and not any(v[0] == t for v in o_rows.values() for t in fresh)
        complete = drained and written_new      # the migration is finished properly: db-new is the source of truth now

        # no issued token was deleted: ids are handed out in a row and nothing removes a live token
        gone = (max_o - LIVE_BASE) - len(o_rows) + (SERVICE - old["svc"])
        if complete:
            gone += (max_n - LIVE_BASE) - len(n_rows)
        if gone > 0:
            crit["nothing-lost"][1] = "часть выданных токенов удалена из базы: не хватает %d записей" % gone
        else:
            crit["nothing-lost"] = [True, "все выданные токены на месте"]

        collide = [i for i in n_rows if i in pend_ins or (i in o_rows and n_rows[i][0] != o_rows[i][0])]
        missing = [i for i in o_rows if i not in n_rows and i not in pend_ins]
        extra = [i for i in n_rows if i not in o_rows and i not in old["pend_del_high"] and not (complete and i > max_o)]
        low_ok = (n_low <= old["low"]) if complete else (n_low - old["low"] == old["pdl"])
        if collide:
            crit["clusters-consistent"][1] = ("на db-new есть %d записей, которые перенос данных ещё только должен туда принести: "
                                              "он столкнётся с ними и остановится" % len(collide))
        elif missing or extra or not low_ok:
            crit["clusters-consistent"][1] = "данные db-new не соответствуют db-old и позиции переноса: часть изменений потеряна или сделана мимо переноса"
        else:
            crit["clusters-consistent"] = [True, "данные db-new соответствуют db-old и позиции переноса"]

        # 6. tokens issued earlier: the newest live ones of each cluster and a few service tokens
        sample = []
        for rows in (o_rows, n_rows):
            sample += [rows[i][0] for i in sorted(rows, reverse=True) if rows[i][1]][:25]
        sample += ["it_" + hashlib.sha1(("seed:%d" % i).encode()).hexdigest()[:24] for i in (3, 41, 77, 118, 164, 209, 256, 299)]
        sample = list(dict.fromkeys(sample))
        refused = sum(1 for t in sample if http("GET", "/v1/tokens/" + t)[0] != 200)
        if refused:
            crit["issued-tokens-valid"][1] = "действующие токены, выданные ранее, не проходят проверку: %d из %d" % (refused, len(sample))
        else:
            crit["issued-tokens-valid"] = [True, "ранее выданные токены проходят проверку: %d из %d" % (len(sample), len(sample))]


try:
    main()
except Exception:
    pass
emit()
PY
rc=$?
[ $rc -eq 0 ] || printf '{"passed":false,"criteria":[{"id":"grader","ok":false,"message":"проверка не смогла выполниться на этом стенде"}]}\n'
