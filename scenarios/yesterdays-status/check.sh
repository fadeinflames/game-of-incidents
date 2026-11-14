#!/bin/sh
# SECRET grader. Result, not method:
#   1. every customer whose budget of the current period is not exhausted is allowed by access-api;
#   2. every customer whose budget of the current period is exhausted is refused;
#   3. budgets, limits and this period's usage in PostgreSQL are what the applied events made them (nothing by hand,
#      no second reset);
#   4. the queue of budget updates has been worked through and no event was lost on the way;
#   5. the refusal does not come back: a late usage record of the closed period that says "exhausted", put at the head
#      of the queue for customers who are allowed now, is applied by the worker and does not block them;
#   6. the rest of Redis is intact (portal sessions, the record counter of the gateways);
#   7. the gateways keep queueing records and the worker keeps applying them.
# Nothing is read from the configuration files under /etc: addresses, ports and the database name are fixed here.
# The grader's own records carry negative numbers and amount 0; they are removed again, and a status they changed is
# dropped from the cache so that the API computes it anew.
PATH=/usr/lib/postgresql/15/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
python3 -I - <<'PY'
import datetime
import hashlib
import json
import os
import subprocess
import time
import urllib.request

BASE = 2310000
API = "http://127.0.0.1:8080"
QUEUE = "queue:budget-updates"
QUEUES = (QUEUE, QUEUE + ":processing")
AFFECTED = [1004, 1011, 1017, 1023, 1029, 1036, 1042, 1048, 1055]   # exhausted the budget of the closed period
STILL_EXHAUSTED = [1008, 1033, 1051]                                # exhausted the new budget, no change of it is queued
SEED_LIMITS = dict(zip(range(1001, 1061), [
    10000, 10000, 3000, 5000, 15000, 8000, 20000, 3000, 8000, 20000,
    8000, 5000, 12000, 5000, 5000, 12000, 5000, 8000, 4000, 6000,
    15000, 3000, 12000, 15000, 8000, 8000, 4000, 5000, 3000, 4000,
    5000, 12000, 5000, 8000, 3000, 10000, 8000, 3000, 6000, 3000,
    8000, 20000, 15000, 8000, 15000, 4000, 5000, 6000, 10000, 5000,
    6000, 10000, 8000, 3000, 4000, 15000, 3000, 6000, 15000, 8000]))
SESSIONS = ["session:" + hashlib.sha256(("wom-yesterdays-status-session-%d" % n).encode()).hexdigest()[:32] for n in range(24)]
QUEUE_OK = 30
UTC = datetime.timezone.utc

crit = {
    "access-restored": [False, "не удалось опросить API доступа"],
    "exhausted-blocked": [False, "не удалось опросить API доступа"],
    "budget-data-intact": [False, "не удалось прочитать бюджеты и расход из базы budgets"],
    "queue-applied": [False, "не удалось прочитать очередь обновлений бюджета"],
    "stays-fixed": [False, "не проверялось: сначала клиенты с неисчерпанным бюджетом должны получать доступ"],
    "redis-intact": [False, "Redis не отвечает"],
    "pipeline-running": [False, "не удалось проверить, что записи шлюзов ставятся в очередь и применяются"],
}
ORDER = list(crit)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def emit():
    passed = all(crit[k][0] for k in ORDER)
    print(json.dumps({"passed": passed, "criteria": [{"id": k, "ok": crit[k][0], "message": crit[k][1]} for k in ORDER]},
                     ensure_ascii=False))


def pq(sql):
    out = subprocess.run(
        ["su", "postgres", "-c", "PGOPTIONS='-c statement_timeout=10000' psql -X -q -tA -F '|' -v ON_ERROR_STOP=1 -d budgets -f -"],
        input=sql, capture_output=True, text=True, timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:200])
    return [line.split("|") for line in out.stdout.splitlines() if line.strip()]


def ask(customer):
    """True / False as the API answers, None when it does not answer."""
    try:
        with opener.open("%s/v1/access/%d" % (API, customer), timeout=4) as resp:
            return bool(json.load(resp).get("allowed"))
    except Exception:
        return None


SNAPSHOT = """
SELECT c.id, COALESCE(b.limit_cents::text, ''), COALESCE(u.spent_cents::text, ''),
       COALESCE((SELECT sum(l.amount_cents) FROM usage_ledger l WHERE l.customer_id = c.id AND l.at >= p.started_at), 0),
       COALESCE((SELECT g.new_limit_cents FROM budget_changes g WHERE g.customer_id = c.id ORDER BY g.seq DESC LIMIT 1), -1),
       to_char(p.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
       (p.started_at = date_trunc('day', p.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int,
       (SELECT count(*) FROM billing_periods)
FROM customers c
LEFT JOIN budgets b ON b.customer_id = c.id
LEFT JOIN usage_current u ON u.customer_id = c.id
CROSS JOIN (SELECT started_at FROM billing_periods ORDER BY started_at DESC LIMIT 1) p
ORDER BY c.id;
"""


def snapshot():
    rows = {}
    for r in pq(SNAPSHOT):
        rows[int(r[0])] = {"limit": int(r[1]) if r[1] else None, "spent": int(r[2]) if r[2] else None, "ledger": int(r[3]),
                           "change": int(r[4]), "started": r[5], "midnight": r[6] == "1", "periods": int(r[7])}
    return rows


def applied_count():
    return int(pq("SELECT count(*) FROM usage_ledger WHERE seq > %d;" % BASE)[0][0])


def main():
    t_start = time.monotonic()
    waited = 0
    while not os.path.exists("/run/.boot-complete") and waited < 80:
        waited += 1
        time.sleep(0.5)

    import redis
    store = redis.Redis(host="127.0.0.1", port=6379, socket_timeout=4, socket_connect_timeout=4, decode_responses=True)
    try:
        seq_start = int(store.get("meter:seq") or 0)
        store_ok = True
    except Exception:
        seq_start, store_ok = 0, False
    try:
        applied_start = applied_count()
    except Exception:
        applied_start = None
    t_first = time.monotonic()

    # ---- 1-3. budget data, and what the API answers for every customer ----------------------------------------------
    try:
        snap = snapshot()
    except Exception:
        snap = None
    allowed_now = []
    if snap:
        ids = sorted(SEED_LIMITS)
        complete = all(c in snap and snap[c]["limit"] is not None and snap[c]["spent"] is not None for c in ids)
        if not complete or len(snap) != len(ids):
            crit["budget-data-intact"][1] = "в базе budgets не хватает клиентов, бюджетов или счётчиков расхода"
        else:
            answers = {c: ask(c) for c in ids}
            wrong = [c for c in ids if answers[c] is not None and answers[c] != (snap[c]["spent"] < snap[c]["limit"])]
            for attempt in range(4):
                if not wrong:
                    break
                time.sleep(0.5)          # the worker may be between the commit and the write to the cache
                try:
                    snap = snapshot()
                except Exception:
                    break
                for c in wrong:
                    answers[c] = ask(c)
                wrong = [c for c in ids if answers[c] is not None and answers[c] != (snap[c]["spent"] < snap[c]["limit"])]
            silent = [c for c in ids if answers[c] is None]
            if silent:
                msg = "API доступа не отвечает на запросы (GET /v1/access/<клиент>)"
                crit["access-restored"][1] = crit["exhausted-blocked"][1] = msg
            else:
                refused = [c for c in wrong if answers[c] is False]
                let_in = [c for c in wrong if answers[c] is True]
                if refused:
                    crit["access-restored"][1] = "отказ получают клиенты с неисчерпанным бюджетом: %d (например, %d)" % (len(refused), refused[0])
                else:
                    crit["access-restored"] = [True, "все клиенты с неисчерпанным бюджетом получают доступ"]
                if let_in:
                    crit["exhausted-blocked"][1] = "доступ получают клиенты, исчерпавшие бюджет текущего периода: %d (например, %d)" % (len(let_in), let_in[0])
                else:
                    crit["exhausted-blocked"] = [True, "клиенты, исчерпавшие бюджет текущего периода, получают отказ"]
                allowed_now = [c for c in AFFECTED if answers[c] is True and snap[c]["spent"] < snap[c]["limit"]]

            any_row = snap[ids[0]]
            bad_limit = [c for c in ids if snap[c]["limit"] != (snap[c]["change"] if snap[c]["change"] >= 0 else SEED_LIMITS[c])]
            bad_spent = [c for c in ids if snap[c]["spent"] != snap[c]["ledger"]]
            bad_fixed = [c for c in STILL_EXHAUSTED if snap[c]["limit"] != SEED_LIMITS[c] or snap[c]["spent"] < snap[c]["limit"]]
            if not any_row["midnight"] or any_row["periods"] != 3:
                crit["budget-data-intact"][1] = ("текущий расчётный период в базе открыт заново: его начало больше не совпадает "
                                                 "с ночным сбросом, счётчики расхода обнулены повторно")
            elif bad_limit:
                crit["budget-data-intact"][1] = ("месячный лимит изменён в обход очереди, клиентов: %d (например, %d); "
                                                 "лимиты меняют только сами клиенты" % (len(bad_limit), bad_limit[0]))
            elif bad_spent or bad_fixed:
                bad = bad_spent or bad_fixed
                crit["budget-data-intact"][1] = ("расход текущего периода не сходится с записями об использовании, клиентов: %d "
                                                 "(например, %d); счётчики расхода править нельзя" % (len(bad), bad[0]))
            else:
                crit["budget-data-intact"] = [True, "бюджеты, лимиты и расход текущего периода в базе не тронуты"]

    # ---- 4, 6. the queue and the rest of Redis ----------------------------------------------------------------------
    max_applied = None
    if store_ok:
        try:
            missing = None
            for attempt in range(4):
                top = int(store.get("meter:seq") or 0)
                raw = []
                for name in QUEUES:
                    raw += store.lrange(name, 0, -1)
                qlen = len(raw)
                head = store.lindex(QUEUE, 0)
                queued = set()
                for item in raw:
                    try:
                        queued.add(int(json.loads(item)["seq"]))
                    except Exception:
                        pass
                applied = {int(r[0]) for r in pq(
                    "SELECT seq FROM usage_ledger WHERE seq > %d UNION ALL SELECT seq FROM budget_changes WHERE seq > %d;" % (BASE, BASE))}
                max_applied = max(applied) if applied else BASE
                upper = max(top, max_applied)
                missing = (upper - BASE) - len({s for s in applied | queued if BASE < s <= upper})
                if missing == 0 or missing > 3:
                    break
                time.sleep(0.5)          # a record that has its number but is not in the queue yet
            age_min = 0
            try:
                queued_at = datetime.datetime.strptime(json.loads(head)["queued_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
                age_min = int((datetime.datetime.now(UTC) - queued_at).total_seconds() // 60)
            except Exception:
                pass
            if missing:
                crit["queue-applied"][1] = "потеряно обновлений бюджета: %d (их нет ни в очереди, ни в базе)" % missing
            elif top < max_applied:
                crit["queue-applied"][1] = ("счётчик записей шлюзов сброшен: нельзя подтвердить, что события из очереди применены, "
                                            "а не потеряны")
            elif qlen > QUEUE_OK:
                crit["queue-applied"][1] = "событий в очереди обновлений бюджета: %d, самое старое ждёт %d мин" % (qlen, age_min)
            else:
                crit["queue-applied"] = [True, "очередь обновлений бюджета разобрана, ни одно событие не потеряно"]

            sessions = sum(1 for key in SESSIONS if store.exists(key))
            counter = int(store.get("meter:seq") or 0)
            if sessions != len(SESSIONS) or counter < max_applied:
                crit["redis-intact"][1] = ("в Redis не хватает данных, которые не относятся к статусам доступа: сессий личного кабинета "
                                           "%d из %d, счётчик записей шлюзов %s" % (sessions, len(SESSIONS), "на месте" if counter >= max_applied else "сброшен"))
            else:
                crit["redis-intact"] = [True, "сессии личного кабинета и счётчик записей шлюзов на месте"]
        except Exception:
            pass

    # ---- 5. a late record of the closed period for customers who are allowed now ------------------------------------
    test_applied = False
    if allowed_now and store_ok and snap:
        targets = allowed_now[:3]
        started = datetime.datetime.strptime(snap[targets[0]]["started"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        stamp = int(time.time() * 1000) % 1000000000
        events = {}
        for n, c in enumerate(targets):
            seq = -(stamp * 10 + n + 1)
            events[seq] = (c, json.dumps({
                "seq": seq, "type": "usage", "customer": c, "amount_cents": 0, "node": "gw-2",
                "at": (started - datetime.timedelta(minutes=25, seconds=7 * n)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "queued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "budget_state": "exhausted", "spent_cents": snap[c]["limit"] + 12, "limit_cents": snap[c]["limit"]}))
        blocked = []
        try:
            for seq, (c, raw) in events.items():
                store.lpush(QUEUE, raw)
            deadline = time.monotonic() + 12
            sql = "SELECT count(*) FROM usage_ledger WHERE seq IN (%s);" % ", ".join(str(s) for s in events)
            while time.monotonic() < deadline:
                if int(pq(sql)[0][0]) == len(events):
                    test_applied = True
                    break
                time.sleep(0.5)
            if not test_applied:
                crit["stays-fixed"][1] = ("budget-worker не применяет обновления: событие, которое грейдер поставил в начало очереди, "
                                          "не применено за 12 с")
            else:
                time.sleep(0.6)
                blocked = [c for c in targets if ask(c) is not True]
                if blocked:
                    crit["stays-fixed"][1] = ("отказ возвращается: за время проверки клиент %d с неисчерпанным бюджетом снова получил отказ, "
                                              "хотя расход и лимит в базе не менялись" % blocked[0])
                else:
                    crit["stays-fixed"] = [True, "за время проверки отказ не вернулся ни к одному клиенту с неисчерпанным бюджетом"]
        finally:
            try:
                for seq, (c, raw) in events.items():
                    for name in QUEUES:
                        store.lrem(name, 0, raw)
                for c in blocked:
                    store.delete("access:%d" % c)
            except Exception:
                pass
            try:
                pq("DELETE FROM usage_ledger WHERE seq < 0;")
            except Exception:
                pass

    # ---- 7. the gateways queue records, the worker applies them -----------------------------------------------------
    if store_ok and applied_start is not None:
        pause = 7 - (time.monotonic() - t_first)
        if pause > 0:
            time.sleep(pause)
        try:
            meter_ok = int(store.get("meter:seq") or 0) > seq_start
            worker_ok = test_applied or applied_count() > applied_start
            if not meter_ok:
                time.sleep(3)
                meter_ok = int(store.get("meter:seq") or 0) > seq_start
            if not worker_ok:
                time.sleep(3)
                worker_ok = applied_count() > applied_start
            if not meter_ok:
                crit["pipeline-running"][1] = "usage-meter не ставит записи шлюзов в очередь"
            elif not worker_ok:
                crit["pipeline-running"][1] = "budget-worker не применяет обновления из очереди"
            else:
                crit["pipeline-running"] = [True, "записи шлюзов ставятся в очередь и применяются"]
        except Exception:
            pass


try:
    main()
except Exception:
    pass
emit()
PY
rc=$?
[ $rc -eq 0 ] || printf '{"passed":false,"criteria":[{"id":"grader","ok":false,"message":"проверка не смогла выполниться на этом стенде"}]}\n'
