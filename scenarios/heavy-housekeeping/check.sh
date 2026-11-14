#!/bin/sh
# SECRET grader. Result, not method. The grader runs the scheduled maintenance of studio/assets.git itself, the way
# cron does (the command of the cron entry, as its user, with the repository forced due), and watches the server:
#   merges-on-time      merge requests opened during the check get their merge commit within 10 s, nothing waits longer
#   storage-stable      gitstored answers all the time, its worker is the same process, its cache is as configured
#   nothing-lost        every merge request ever opened is in git, and the ones without a merge commit are in the queue
#   housekeeping-works  the job is scheduled, enabled, excludes nothing, the run does not fail, the repository is packed
#   job-within-budget   the anonymous memory of the maintenance run stays under 150 MB
#   repos-intact        the files of studio/assets.git and the branches of the code repositories are what they were
# Nothing the player can edit is trusted, except the cron entry and the settings the job itself reads: those are the
# thing under test. Git is run with a clean environment and without the system configuration.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
python3 -I - <<'PY'
import glob
import hashlib
import json
import os
import pwd
import re
import signal
import subprocess
import time
import urllib.request

ROOT = "/var/lib/git"
BIG = "studio/assets.git"
BIG_TREE = "66ae7bfda01ba0b09ae44ba2dab2bec26a20560e"   # sha1 of `git ls-tree -r refs/heads/main` after the import
CODE = {
    "docs/handbook.git": "609b2d82772fd543e621e549f52e327a41c91a62",
    "mobile/app.git": "8c8b75ba8f02fbf3f4a59a5e03a2af8aef02340a",
    "platform/billing-api.git": "d7647d4b82a1a7574f70e3516017d17efbe9c162",
    "platform/deploy-tools.git": "6d54945554509958d3ba3a9d7b51cd3c18182c94",
    "web/checkout.git": "28c83807fa3f225aa4e351fd08459917f99232a4",
    "web/storefront.git": "1d86d6518c0ee60fdd07a42d1f00931cb60152ee",
}
HEALTH = "http://127.0.0.1:8075/health"
PENDING = "/var/spool/mergeq/pending"
CACHE_MB = 332
BUDGET_MB = 150       # anonymous memory one maintenance run may take
ON_TIME = 10          # seconds a merge request may wait for its merge commit
LOCK_WAIT = 30        # seconds to wait for a scheduled run that is in progress
WINDOW_MIN = 14       # the server is watched at least this long ...
WINDOW_MAX = 40       # ... and a maintenance run is watched at most this long
MAX_PACKS = 10

GATE = "проверяется, когда gitstored работает без перерывов и merge-коммиты создаются вовремя"
crit = {
    "merges-on-time": [False, "не удалось проверить, вовремя ли создаются merge-коммиты"],
    "storage-stable": [False, "не удалось проверить работу gitstored"],
    "nothing-lost": [False, "не удалось прочитать запросы на слияние из репозиториев"],
    "housekeeping-works": [False, GATE],
    "job-within-budget": [False, GATE],
    "repos-intact": [False, "не удалось проверить целостность репозиториев"],
}
ORDER = list(crit)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
GIT_ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}


def emit():
    passed = all(crit[k][0] for k in ORDER)
    print(json.dumps({"passed": passed, "criteria": [{"id": k, "ok": crit[k][0], "message": crit[k][1]} for k in ORDER]},
                     ensure_ascii=False))


def git(repo, *args, timeout=120):
    return subprocess.run(["/usr/bin/git", "-C", os.path.join(ROOT, repo)] + list(args), capture_output=True, text=True,
                          env=GIT_ENV, user="git", group="git", extra_groups=[], timeout=timeout)


def health():
    """-> (worker pid, cache MiB) or None"""
    try:
        with opener.open(HEALTH, timeout=2) as resp:
            doc = json.loads(resp.read())
        return int(doc["worker_pid"]), int(doc["cache_mb"])
    except Exception:
        return None


def oom_kills():
    try:
        with open("/sys/fs/cgroup/memory.events") as f:
            for line in f:
                if line.startswith("oom_kill "):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return 0


def packs(repo):
    try:
        return sum(1 for n in os.listdir(os.path.join(ROOT, repo, "objects", "pack")) if n.endswith(".pack"))
    except OSError:
        return -1


def pack_ids(repo):
    out = set()
    d = os.path.join(ROOT, repo, "objects", "pack")
    try:
        for n in os.listdir(d):
            if n.endswith(".pack"):
                st = os.stat(os.path.join(d, n))
                out.add((n, st.st_ino, st.st_mtime_ns))
    except OSError:
        pass
    return out


def requests():
    """-> {id: {"repo", "head", "created", "merge", "merged", "parents"}} from the refs of the code repositories"""
    out = {}
    for repo in CODE:
        p = git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(parent)", "refs/merge-requests/")
        if p.returncode != 0:
            raise RuntimeError(repo)
        for line in p.stdout.splitlines():
            ref, oid, date, parents = (line.split("\t") + ["", "", ""])[:4]
            m = re.match(r"^refs/merge-requests/(\d+)/(head|merge)$", ref)
            if not m:
                continue
            mr = out.setdefault(int(m.group(1)), {"repo": repo})
            if m.group(2) == "head":
                mr["head"], mr["created"] = oid, int(date)
            else:
                mr["merge"], mr["merged"], mr["parents"] = oid, int(date), parents.split()
    return out


def cron_entry():
    """-> (user, command, environment assignments of the file) of the active cron line that runs the housekeeping"""
    for path in ["/etc/crontab"] + sorted(glob.glob("/etc/cron.d/*")):
        env = {}
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        for line in lines:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", s)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("\"'")
                continue
            parts = s.split(None, 6)
            if len(parts) == 7 and "git-housekeeping" in parts[6]:
                return parts[5], parts[6], env
    for path in sorted(glob.glob("/var/spool/cron/crontabs/*")):
        try:
            with open(path) as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        for line in lines:
            s = line.strip()
            parts = s.split(None, 5)
            if s and not s.startswith("#") and len(parts) == 6 and "git-housekeeping" in parts[5]:
                return os.path.basename(path), parts[5], {}
    return None


def cron_alive():
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(d + "/comm") as f:
                if f.read().strip() == "cron":
                    return True
        except OSError:
            pass
    return False


def session_usage(sid):
    """-> (anonymous memory of the session in kB, whether git pack-objects runs in it)"""
    total, packing = 0, False
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(d + "/stat") as f:
                fields = f.read().rsplit(")", 1)[1].split()
            if int(fields[3]) != sid:
                continue
            with open(d + "/status") as f:
                for line in f:
                    if line.startswith("RssAnon:"):
                        total += int(line.split()[1])
                        break
            with open(d + "/cmdline", "rb") as f:
                if b"pack-objects" in f.read():
                    packing = True
        except (OSError, ValueError, IndexError):
            continue
    return total, packing


def main():
    # a grader started while the container is still booting waits for the services
    for _ in range(60):
        if os.path.exists("/run/.boot-complete"):
            break
        time.sleep(0.5)

    t0 = int(time.time())
    h0 = health()
    kills0 = oom_kills()
    packs0 = pack_ids(BIG)

    # ---- the schedule and the settings in effect, asked from the job itself
    schedule_problem = None
    entry = cron_entry()
    if entry is None or not cron_alive():
        schedule_problem = "плановое обслуживание репозиториев не запланировано: в cron нет активной строки с git-housekeeping или cron не работает"
    else:
        try:
            pwd.getpwnam(entry[0])
        except KeyError:
            schedule_problem = "плановое обслуживание запланировано от несуществующего пользователя %s" % entry[0]
    plan = ""
    try:
        plan = subprocess.run(["/usr/local/bin/git-housekeeping", "--plan"], capture_output=True, text=True, timeout=30,
                              env={"PATH": "/usr/bin:/bin", "HOME": "/var/lib/git"}, user="git", group="git", extra_groups=[]).stdout
    except Exception:
        pass
    if schedule_problem is None:
        if "settings: enabled=yes " not in plan:
            schedule_problem = "плановое обслуживание репозиториев выключено"
        else:
            left_out = [r for r in list(CODE) + [BIG] if not re.search(r"^%s: .* -> (ok|due)" % re.escape(r), plan, re.M)]
            if left_out:
                schedule_problem = "из планового обслуживания исключены репозитории: %s" % ", ".join(sorted(left_out))

    # ---- the maintenance run of studio/assets.git, started the way cron starts it, and the server meanwhile
    job = None
    job_rc = None
    job_seen = False
    job_cut = False
    peak_kb = 0
    storage_gaps = 0
    worker_changed = False
    storage_lost = False
    cache_seen = h0[1] if h0 else None
    if h0 is not None and schedule_problem is None:
        user, command, file_env = entry
        pw = pwd.getpwnam(user)
        env = {"PATH": "/usr/bin:/bin", "HOME": pw.pw_dir, "LOGNAME": user, "SHELL": "/bin/sh"}
        env.update(file_env)
        env.update({"GIT_HOUSEKEEPING_FORCE": BIG, "GIT_HOUSEKEEPING_WAIT": str(LOCK_WAIT)})
        try:
            job = subprocess.Popen(["/bin/sh", "-c", command], env=env, cwd="/", user=user, group=pw.pw_gid,
                                   extra_groups=os.getgrouplist(user, pw.pw_gid), start_new_session=True,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            job = None
    started = time.time()
    seen_at = None
    last_health = 0.0
    while True:
        now = time.time()
        if job is not None:
            used, packing = session_usage(job.pid)
            peak_kb = max(peak_kb, used)
            if packing and not job_seen:
                job_seen, seen_at = True, now
            if job_rc is None:
                job_rc = job.poll()
        if now - last_health >= 1.0:
            last_health = now
            h = health()
            if h is None:
                storage_gaps += 1
            else:
                storage_gaps = 0
                cache_seen = h[1]
                if h0 is not None and h[0] != h0[0]:
                    worker_changed = True
        running = job is not None and job_rc is None
        if h0 is None:
            break                                   # nothing to watch: the storage is down already
        if worker_changed or storage_gaps >= 2:
            storage_lost = True                     # the verdict is clear: stop the run, do not hurt the stand further
            break
        if not running and now - started >= WINDOW_MIN:
            break
        if running and seen_at is not None and now - seen_at >= WINDOW_MAX:
            job_cut = True
            break
        if running and seen_at is None and now - started >= LOCK_WAIT + 8:
            job_cut = True
            break
        time.sleep(0.25)
    if job is not None and job_rc is None:
        try:
            os.killpg(job.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            job.wait(timeout=8)
        except Exception:
            try:
                os.killpg(job.pid, signal.SIGKILL)
            except OSError:
                pass
    t_end = int(time.time())
    kills = oom_kills() - kills0

    # ---- merge requests: wait for the ones opened during the check, then read everything from git
    reqs = None
    deadline = time.time() + ON_TIME + 3
    while True:
        try:
            reqs = requests()
        except Exception:
            reqs = None
            break
        fresh = [r for r in reqs.values() if "head" in r and t0 <= r["created"] <= t_end - 2]
        if all("merge" in r for r in fresh) or time.time() >= deadline or h0 is None or storage_lost:
            break
        time.sleep(1)
    now = int(time.time())

    if reqs is not None:
        fresh = [r for r in reqs.values() if "head" in r and t0 <= r["created"] <= t_end - 2]
        waits = [(r["merged"] - r["created"]) if "merge" in r else (now - r["created"]) for r in fresh]
        late = sum(1 for w in waits if w > ON_TIME)
        backlog = sorted(now - r["created"] for r in reqs.values() if "head" in r and "merge" not in r and now - r["created"] > ON_TIME)
        if h0 is None:
            if backlog:
                crit["merges-on-time"][1] = "merge-коммиты не создаются: запросов в очереди %d, самый старый ждёт уже %d с" % (len(backlog), backlog[-1])
            else:
                crit["merges-on-time"][1] = "merge-коммиты сейчас не создаются: gitstored не отвечает"
        elif storage_lost:
            stuck = sum(1 for r in reqs.values() if "head" in r and "merge" not in r)
            crit["merges-on-time"][1] = "во время проверки merge-коммиты перестали создаваться: gitstored не отвечает, запросов в очереди уже %d" % stuck
        elif late:
            crit["merges-on-time"][1] = ("merge-коммиты создаются с опозданием: из запросов, открытых за время проверки, дольше положенного ждали %d из %d (положено не больше %d с, "
                                         "самое долгое ожидание %d с)" % (late, len(fresh), ON_TIME, max(waits)))
        elif backlog:
            crit["merges-on-time"][1] = "в очереди остались старые запросы на слияние: %d, самый старый ждёт уже %d с" % (len(backlog), backlog[-1])
        elif len(fresh) < 3:
            crit["merges-on-time"][1] = "за время проверки почти не появилось новых запросов на слияние: проверять нечем (сервис loadgen должен работать)"
        else:
            crit["merges-on-time"] = [True, "merge-коммиты создаются вовремя: запросов за время проверки %d, самое долгое ожидание %d с" % (len(fresh), max(waits))]

        # nothing lost: ids are handed out in a row; a request without a merge commit must still be in the queue
        heads = {i for i, r in reqs.items() if "head" in r}
        top = max(heads, default=0)
        gone = [i for i in range(1, top + 1) if i not in heads]
        dropped = [i for i, r in reqs.items() if "head" in r and "merge" not in r and now - r["created"] > 5
                   and not os.path.exists(os.path.join(PENDING, "%08d.mr" % i))]
        forged = [i for i, r in reqs.items() if "head" in r and "merge" in r and (len(r["parents"]) != 2 or r["parents"][1] != r["head"])]
        if len(gone) > 2:
            crit["nothing-lost"][1] = "часть запросов на слияние удалена из репозиториев: не хватает %d" % len(gone)
        elif dropped:
            crit["nothing-lost"][1] = "потеряны запросы на слияние: %d (merge-коммита у них нет и в очереди mergeq их тоже нет)" % len(dropped)
        elif forged:
            crit["nothing-lost"][1] = "merge-коммит не соответствует своему запросу на слияние: таких запросов %d" % len(forged)
        else:
            crit["nothing-lost"] = [True, "все запросы на слияние на месте: %d, без merge-коммита сейчас %d" % (top, len(heads) - sum(1 for r in reqs.values() if "merge" in r and "head" in r))]

    # ---- the storage service
    if h0 is None:
        crit["storage-stable"][1] = "gitstored не отвечает на 127.0.0.1:8075: рабочего процесса сейчас нет"
    elif storage_lost:
        crit["storage-stable"][1] = "за время проверки gitstored перестал отвечать: его рабочий процесс завершился"
    elif cache_seen != CACHE_MB:
        crit["storage-stable"][1] = "настройки gitstored изменены: кэш %s МиБ вместо %d, а по условию их не трогаем" % (cache_seen, CACHE_MB)
    else:
        crit["storage-stable"] = [True, "gitstored отвечал всю проверку, рабочий процесс не менялся"]

    # ---- the repositories
    problems = []

    def fsck_fails(repo, *args):
        # a scheduled repack may swap packs under a running fsck: one more try settles it
        for attempt in (0, 1):
            if git(repo, "fsck", "--no-dangling", "--no-progress", *args, timeout=150).returncode == 0:
                return False
            time.sleep(2)
        return True

    try:
        p = git(BIG, "ls-tree", "-r", "refs/heads/main")
        if p.returncode != 0 or hashlib.sha1(p.stdout.encode()).hexdigest() != BIG_TREE:
            problems.append("в %s изменился набор файлов ветки main" % BIG)
        elif fsck_fails(BIG):
            problems.append("%s повреждён: git fsck находит ошибки" % BIG)
        for repo, tip in CODE.items():
            p = git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/main")
            if p.stdout.strip() != tip:
                problems.append("в %s изменилась ветка main" % repo)
            elif fsck_fails(repo, "--connectivity-only"):
                problems.append("%s повреждён: git fsck находит ошибки" % repo)
        if problems:
            crit["repos-intact"][1] = "; ".join(problems[:3])
        else:
            crit["repos-intact"] = [True, "репозитории целы: файлы %s и ветки main остальных на месте, git fsck без ошибок" % BIG]
    except Exception:
        pass

    # ---- the maintenance: judged once the symptoms are gone, so that a failing first check names only symptoms
    if schedule_problem is not None and h0 is not None and crit["merges-on-time"][0]:
        crit["housekeeping-works"][1] = schedule_problem
        crit["job-within-budget"][1] = "не измерено: плановое обслуживание %s не запускается" % BIG
        return
    if not (crit["merges-on-time"][0] and crit["storage-stable"][0]):
        return
    repacked = job_seen or pack_ids(BIG) != packs0
    n_packs = packs(BIG)
    peak_mb = peak_kb // 1024
    if job is None:
        crit["housekeeping-works"][1] = "не удалось запустить плановое обслуживание так, как его запускает cron"
    elif job_rc == 75 or (job_cut and not job_seen):
        crit["housekeeping-works"][1] = "не удалось дождаться своей очереди: другой запуск обслуживания шёл дольше %d с; повтори проверку, когда он закончится" % LOCK_WAIT
    elif job_rc == 3:
        crit["housekeeping-works"][1] = "обслуживание %s не запускается: оно выключено или репозиторий исключён" % BIG
    elif job_rc not in (0, None):
        crit["housekeeping-works"][1] = "обслуживание %s завершается с ошибкой (код %s): подробности в /var/log/git-housekeeping/housekeeping.log" % (BIG, job_rc)
    elif not repacked:
        crit["housekeeping-works"][1] = "строка cron выполнилась, но обслуживание %s при этом не запустилось" % BIG
    elif n_packs > MAX_PACKS or n_packs < 1:
        crit["housekeeping-works"][1] = ("обслуживание %s идёт без ошибок, но за %d с проверки не успело закончиться и раньше ни разу не завершалось "
                                         "(в репозитории %d pack-файлов): дождись планового запуска и повтори проверку" % (BIG, WINDOW_MAX, n_packs))
    else:
        how = "ещё шло, когда проверка его остановила" if job_cut else "завершилось без ошибок"
        crit["housekeeping-works"] = [True, "плановое обслуживание работает для всех репозиториев; обслуживание %s %s" % (BIG, how)]

    if job is None or not job_seen:
        crit["job-within-budget"][1] = "не измерено: обслуживание %s не запустилось" % BIG
    elif kills > 0:
        crit["job-within-budget"][1] = "во время обслуживания %s серверу не хватило памяти: ядро завершило процесс (oom_kill в /sys/fs/cgroup/memory.events)" % BIG
    elif peak_mb > BUDGET_MB:
        crit["job-within-budget"][1] = "обслуживание %s занимало до %d МБ памяти при разрешённых %d МБ" % (BIG, peak_mb, BUDGET_MB)
    else:
        crit["job-within-budget"] = [True, "обслуживание %s занимало не больше %d МБ памяти (разрешено %d МБ)" % (BIG, peak_mb, BUDGET_MB)]


try:
    main()
except Exception:
    pass
emit()
PY
rc=$?
[ $rc -eq 0 ] || printf '{"passed":false,"criteria":[{"id":"grader","ok":false,"message":"проверка не смогла выполниться на этом стенде"}]}\n'
