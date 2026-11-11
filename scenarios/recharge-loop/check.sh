#!/bin/sh
# SECRET grader. Result, not method:
#   the damage was stopped in time, cards are no longer charged, the balances primary takes writes and holds exactly
#   what the ledger says, every charge made while the real balance was above the threshold is booked for refund (and no other), the data and
#   the role of the primary survive a restart with the file the service is configured with, both replicas follow the
#   primary, and the worker rates usage again.
# Nothing is read from files that tell the services where to connect: ports and paths are fixed here.
# The restart is tried on a copy of the data directory in /tmp, on another port: the live primary is not restarted.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
python3 -I - <<'PY'
import json
import os
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import time

IDS = list(range(1001, 1041))
KEYS = ["balance:%d" % i for i in IDS]
LEDGER = "/var/lib/billing/billing.db"
PROC = "/var/lib/cardproc/cardproc.db"
HIST_CHARGES = 7              # charges that come with the image: honest recharges of the last day
LIMIT = 400                   # how many charges after them finance agreed to sort out by hand
OPENING_SIG = 151628830       # SUM(account_id * amount_cents) over the opening entries of the image
ACCT_SIG = 24674952428        # the auto-recharge settings of the image
TEST_PORT = 6399

crit = {
    "damage-bounded": [False, "не удалось посчитать списания в базе процессинга"],
    "charges-stopped": [False, "карты клиентов продолжают списываться"],
    "primary-writable": [False, "основной узел балансов (порт 6379) не принимает запись"],
    "ledger-intact": [False, "журнал проводок не удалось прочитать"],
    "balances-match": [False, "балансы в Redis не удалось сверить с журналом проводок"],
    "refunds-booked": [False, "не удалось проверить возвраты"],
    "restart-safe": [False, "не проверялось: сначала основной узел должен принимать запись, а балансы совпадать с журналом"],
    "replicas-attached": [False, "реплики балансов не следуют за основным узлом"],
    "worker-running": [False, "billing-worker не тарифицирует события"],
}
ORDER = list(crit)


def emit():
    passed = all(crit[k][0] for k in ORDER)
    print(json.dumps({"passed": passed, "criteria": [{"id": k, "ok": crit[k][0], "message": crit[k][1]} for k in ORDER]},
                     ensure_ascii=False))


def ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=5)


def one(path, sql, args=()):
    db = ro(path)
    try:
        return db.execute(sql, args).fetchone()
    finally:
        db.close()


def rconn(port):
    import redis
    return redis.Redis(host="127.0.0.1", port=port, socket_timeout=3, socket_connect_timeout=3, decode_responses=True)


def worker_alive():
    try:
        pid = int(open("/run/billing-worker.pid").read().strip())
        return b"billing_worker.py" in open("/proc/%d/cmdline" % pid, "rb").read()
    except Exception:
        return False


def main():
    # 1-2. the damage so far, and whether it still grows: two counts six seconds apart
    try:
        c1 = one(PROC, "SELECT COUNT(*) FROM charges")[0]
        u1 = one(LEDGER, "SELECT COUNT(*) FROM ledger WHERE kind = 'usage'")[0]
    except Exception:
        c1 = u1 = None
    time.sleep(6)
    try:
        c2, top = one(PROC, "SELECT COUNT(*), COALESCE(MAX(seq), 0) FROM charges")
        late = one(PROC, "SELECT COUNT(*) FROM charges WHERE seq > ?", (HIST_CHARGES,))[0]
        u2 = one(LEDGER, "SELECT COUNT(*) FROM ledger WHERE kind = 'usage'")[0]
    except Exception:
        c2 = u2 = None
    if c2 is not None:
        if top != c2 or c2 < HIST_CHARGES:
            crit["damage-bounded"][1] = "в базе процессинга не хватает записей о списаниях: её нельзя править"
        elif late > LIMIT:
            crit["damage-bounded"][1] = "с начала инцидента с карт списано %d раз: финансы готовы разобрать не больше %d, списания нужно было остановить раньше" % (late, LIMIT)
        else:
            crit["damage-bounded"] = [True, "списаний с начала инцидента: %d (предел %d)" % (late, LIMIT)]
        if c1 is not None and c2 == c1:
            crit["charges-stopped"] = [True, "новых списаний с карт нет"]
        elif c1 is not None:
            crit["charges-stopped"][1] = "карты клиентов продолжают списываться: %d новых списаний за 6 секунд" % (c2 - c1)
    if u1 is not None and u2 is not None:
        if not worker_alive():
            crit["worker-running"][1] = "billing-worker не запущен: к концу работ он должен тарифицировать события"
        elif u2 > u1:
            crit["worker-running"] = [True, "billing-worker запущен и тарифицирует события"]
        else:
            crit["worker-running"][1] = "billing-worker запущен, но за 6 секунд не записал в журнал ни одного события"

    # 3. the primary takes a write (the probe key is removed at once)
    primary = None
    try:
        primary = rconn(6379)
        role = primary.info("replication").get("role")
        probe = "wom:probe:%d" % os.getpid()
        try:
            primary.set(probe, "1", ex=10)
            primary.delete(probe)
            if role == "master":
                crit["primary-writable"] = [True, "основной узел балансов принимает запись"]
        except Exception:
            pass
    except Exception:
        crit["primary-writable"][1] = "основной узел балансов (порт 6379) не отвечает"
        primary = None

    # 4-6. the ledger, the processor and the balances, read together; a running worker may be between two writes,
    # so a mismatch is read again a few times
    snap = None
    for attempt in range(5):
        try:
            db = ro(LEDGER)
            sums = dict(db.execute("SELECT account_id, SUM(amount_cents) FROM ledger GROUP BY account_id"))
            opening = db.execute("SELECT COUNT(*), COALESCE(SUM(account_id * amount_cents), 0) FROM ledger WHERE kind = 'opening'").fetchone()
            acct = db.execute("SELECT COUNT(*), COALESCE(SUM(id * (auto_recharge * 1000003 + threshold_cents * 7 + recharge_cents)), 0) FROM accounts").fetchone()
            bad_usage = db.execute("SELECT COUNT(*) FROM ledger WHERE kind = 'usage' AND amount_cents >= 0").fetchone()[0]
            recharges = sorted(db.execute("SELECT ref, account_id, amount_cents FROM ledger WHERE kind = 'recharge'"))
            refunds = db.execute("SELECT ref, account_id, amount_cents FROM ledger WHERE kind = 'refund'").fetchall()
            db.close()
            db = ro(PROC)
            charges = sorted(db.execute("SELECT id, account_id, amount_cents FROM charges"))
            late_ids = {r[0]: (r[1], r[2]) for r in db.execute("SELECT id, account_id, amount_cents FROM charges WHERE seq > ?", (HIST_CHARGES,))}
            proc_refunds = {r[0] for r in db.execute("SELECT charge_id FROM refunds")}
            db.close()
        except Exception:
            break
        values = None
        if primary is not None:
            try:
                values = primary.mget(KEYS)
            except Exception:
                values = None
        wrong = None
        if values is not None:
            wrong = sum(1 for i, v in zip(IDS, values) if v is None or not v.lstrip("-").isdigit() or int(v) != sums.get(i))
        snap = (sums, opening, acct, bad_usage, recharges, refunds, charges, late_ids, proc_refunds, values, wrong)
        if recharges == charges and (wrong in (0, None)):
            break
        time.sleep(0.4)

    balances_ok = False
    if snap is not None:
        sums, opening, acct, bad_usage, recharges, refunds, charges, late_ids, proc_refunds, values, wrong = snap
        if tuple(opening) != (len(IDS), OPENING_SIG) or tuple(acct) != (len(IDS), ACCT_SIG) or bad_usage:
            crit["ledger-intact"][1] = "начальные остатки, проводки или настройки автопополнения в базе биллинга изменены: их нельзя править"
        elif recharges != charges:
            crit["ledger-intact"][1] = "пополнения в журнале проводок не сходятся со списаниями в процессинге (%d против %d)" % (len(recharges), len(charges))
        else:
            crit["ledger-intact"] = [True, "журнал проводок цел и сходится с процессингом"]

        if values is None:
            crit["balances-match"][1] = "балансы не удалось прочитать с основного узла"
        elif wrong:
            crit["balances-match"][1] = "баланс в Redis расходится с журналом проводок у %d счетов из %d" % (wrong, len(IDS))
        else:
            balances_ok = True
            crit["balances-match"] = [True, "балансы всех %d счетов равны сумме проводок" % len(IDS)]

        booked = {}
        for ref, account, amount in refunds:
            booked.setdefault(ref, []).append((account, amount))
        good = sum(1 for cid, (account, amount) in late_ids.items()
                   if booked.get(cid) == [(account, -amount)] and cid in proc_refunds)
        extra = len((set(booked) | proc_refunds) - set(late_ids))
        if extra:
            crit["refunds-booked"][1] = "возврат оформлен для %d законных списаний (баланс клиента был ниже порога): такие возвращать нельзя" % extra
        elif good != len(late_ids):
            crit["refunds-booked"][1] = "к возврату оформлено %d из %d ошибочных списаний" % (good, len(late_ids))
        elif late_ids:
            crit["refunds-booked"] = [True, "все %d ошибочных списаний оформлены к возврату" % good]
        else:
            crit["refunds-booked"] = [True, "ошибочных списаний нет, возвраты не нужны"]

    # 7. both replicas follow the primary and hold what it holds
    try:
        attached = 0
        for port in (6380, 6381):
            for attempt in range(4):
                try:
                    r = rconn(port)
                    info = r.info("replication")
                    same = r.mget(KEYS) == primary.mget(KEYS)
                    if (info.get("role") == "slave" and str(info.get("master_port")) == "6379"
                            and info.get("master_host") in ("127.0.0.1", "localhost", "::1")
                            and info.get("master_link_status") == "up" and same):
                        attached += 1
                        break
                except Exception:
                    pass
                time.sleep(0.4)
        if attached == 2 and crit["primary-writable"][0]:
            crit["replicas-attached"] = [True, "обе реплики подключены к основному узлу и хранят те же балансы"]
        else:
            crit["replicas-attached"][1] = "за основным узлом следуют %d из 2 реплик (порты 6380 и 6381)" % (attached if crit["primary-writable"][0] else 0)
    except Exception:
        pass

    # 8. what the next restart of the service would give, tried on a copy
    if crit["primary-writable"][0] and balances_ok:
        crit["restart-safe"] = restart_test(primary)


def restart_test(primary):
    fail = [False, "после перезапуска сервиса redis-balances балансы пропадут или запись снова перестанет работать"]
    conf = "/etc/redis/balances.conf"
    try:
        out = subprocess.run(["/bin/sh", "-c", '. /etc/default/redis-balances >/dev/null 2>&1; printf %s "${CONFIG:-}"'],
                             stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5).stdout.strip()
        if out:
            conf = out
    except Exception:
        pass
    conf_dir = None
    try:
        for line in open(conf, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                words = shlex.split(line)
            except ValueError:
                continue
            if not words:
                continue
            key = words[0].lower()
            if key == "dir" and len(words) > 1:
                conf_dir = words[1]
            if key in ("replicaof", "slaveof") and [w.lower() for w in words[1:3]] != ["no", "one"]:
                return fail
    except Exception:
        return [False, "файл конфигурации сервиса redis-balances не читается"]

    tmp = None
    proc = None
    try:
        live_dir = primary.config_get("dir")["dir"]
        dbfile = primary.config_get("dbfilename")["dbfilename"]
        saves = primary.config_get("save").get("save", "")
        if conf_dir is None or os.path.realpath(conf_dir) != os.path.realpath(live_dir):
            return fail
        before = primary.mget(KEYS)
        tmp = tempfile.mkdtemp(prefix="wom-restart-", dir="/tmp")
        data = os.path.join(tmp, "data")
        shutil.copytree(live_dir, data, symlinks=True)
        if saves:
            # a clean stop writes a final snapshot when snapshots are configured
            subprocess.run(["redis-cli", "-h", "127.0.0.1", "-p", "6379", "--rdb", os.path.join(data, dbfile)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        later = primary.mget(KEYS)
        for root, dirs, files in os.walk(tmp):
            for name in [root] + [os.path.join(root, f) for f in files]:
                shutil.chown(name, "redis", "redis")
        proc = subprocess.Popen(
            ["redis-server", conf, "--port", str(TEST_PORT), "--bind", "127.0.0.1", "--dir", data, "--daemonize", "no",
             "--logfile", os.path.join(tmp, "log"), "--pidfile", os.path.join(tmp, "pid"),
             "--unixsocket", os.path.join(tmp, "sock")],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            user="redis", group="redis", extra_groups=[], cwd=tmp)
        copy = rconn(TEST_PORT)
        ready = False
        for attempt in range(60):
            try:
                if str(copy.info("persistence").get("loading")) == "0":
                    ready = True
                    break
            except Exception:
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.2)
        if not ready:
            return fail
        role = copy.info("replication").get("role")
        after = copy.mget(KEYS)
        # the snapshot was taken somewhere between the two reads of the live balances, and the worker may be running
        def taken_between(b, a, c):
            if b is None or a is None or c is None:
                return False
            if a in (b, c):
                return True
            try:
                return min(int(b), int(c)) <= int(a) <= max(int(b), int(c))
            except ValueError:
                return False
        same = all(taken_between(b, a, c) for b, a, c in zip(before, after, later))
        try:
            copy.set("wom:probe", "1")
            writable = True
        except Exception:
            writable = False
        if role == "master" and writable and same:
            return [True, "после перезапуска сервиса балансы на месте, узел остаётся основным и принимает запись"]
        return fail
    except Exception:
        return fail
    finally:
        if proc is not None:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except Exception:
                pass
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


try:
    main()
except Exception:
    pass
emit()
PY
rc=$?
[ $rc -eq 0 ] || printf '{"passed":false,"criteria":[{"id":"grader","ok":false,"message":"проверка не смогла выполниться на этом стенде"}]}\n'
