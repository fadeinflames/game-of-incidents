#!/usr/bin/env python3
"""Every service of the stand in one file; the role is picked by ROLE (or by the first argument).

  submitter   stands for the clients: enqueues JOBS_PER_SEC jobs per second
  queue       in-memory job queue. A dispatcher takes a job with POST /take; the queue hands out at most one job per
              second to one dispatcher (by source address). A job that has waited START_DEADLINE_SEC is dropped as
              failed-to-start.
  dispatcher  takes jobs from the queue and starts them
  controller  capacity-controller: owns the replica count of deployment/dispatcher and applies the capacity plan
  stats       CLI: pretty-print the local /stats (queue, submitter) or /status (controller)
"""
import collections
import configparser
import hashlib
import http.client
import json
import math
import os
import re
import signal
import ssl
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def utc(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def log(level, msg):
    print(f"{utc()} {level:<5} {msg}", flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def handle_error(self, request, client_address):
        pass  # a client that went away is not news


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, code, obj=None, text=None):
        if obj is not None:
            body, ctype = (json.dumps(obj) + "\n").encode(), "application/json"
        elif text is not None:
            body, ctype = text.encode(), "text/plain; charset=utf-8"
        else:
            body, ctype = b"", None
        self.send_response(code)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def drain(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)


def serve(port, handler):
    srv = Server(("0.0.0.0", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------------------------------------------------------------------------------------------------------------------
# queue
# ---------------------------------------------------------------------------------------------------------------------
START_DEADLINE_SEC = 20.0   # a job that was not started in this time is failed for the client
ON_TIME_SEC = 5.0           # a start within this time counts as "on time"
TAKE_INTERVAL_SEC = 1.0     # one dispatcher gets at most one job per this interval
LONG_POLL_SEC = 5.0

QUEUE_HELP = """job queue

GET  /stats         counters, the waiting jobs, the last minute
GET  /healthz
POST /enqueue?id=N  put a job (clients)
POST /take          take the oldest waiting job (dispatchers); waits up to 5 s for one; 204 if there is none.
                    One dispatcher gets at most one job per second.
POST /admin/purge   drop every waiting job without starting it

A job that has waited 20 s without being taken is dropped as failed-to-start.
The queue keeps its state in memory.
"""


class JobQueue:
    def __init__(self):
        self.cond = threading.Condition()
        self.jobs = collections.deque()      # (job id, monotonic time of arrival)
        self.next_slot = {}                  # dispatcher address -> monotonic time of its next allowed take
        self.last_seen = {}                  # dispatcher address -> monotonic time of its last /take
        self.events = collections.deque()    # (monotonic time, kind, waited seconds), the last 60 s
        self.totals = {"received": 0, "started": 0, "failed_to_start": 0, "purged": 0}
        self.born = time.monotonic()

    def _sweep(self, now):
        # called with the lock held
        while self.jobs and now - self.jobs[0][1] >= START_DEADLINE_SEC:
            self.jobs.popleft()
            self.totals["failed_to_start"] += 1
            self.events.append((now, "failed", START_DEADLINE_SEC))
        while self.events and now - self.events[0][0] > 60.0:
            self.events.popleft()

    def enqueue(self, jid):
        with self.cond:
            now = time.monotonic()
            self.jobs.append((jid, now))
            self.totals["received"] += 1
            self.events.append((now, "received", 0.0))
            self.cond.notify_all()

    def take(self, who):
        with self.cond:
            deadline = time.monotonic() + LONG_POLL_SEC
            while True:
                now = time.monotonic()
                self._sweep(now)
                self.last_seen[who] = now
                slot = self.next_slot.get(who, 0.0)
                if self.jobs and now >= slot:
                    jid, born = self.jobs.popleft()
                    waited = now - born
                    # a dispatcher that comes back a little late keeps its pace of one job per interval
                    self.next_slot[who] = max(slot, now - 0.25) + TAKE_INTERVAL_SEC
                    self.totals["started"] += 1
                    self.events.append((now, "started", waited))
                    return jid, waited
                if now >= deadline:
                    return None
                wait = deadline - now
                if self.jobs:
                    wait = min(wait, slot - now)
                self.cond.wait(max(wait, 0.01))

    def purge(self):
        with self.cond:
            n = len(self.jobs)
            self.jobs.clear()
            self.totals["purged"] += n
            return n

    def window(self, seconds):
        # called with the lock held
        now = time.monotonic()
        self._sweep(now)
        ev = [e for e in self.events if now - e[0] <= seconds]
        waits = [e[2] for e in ev if e[1] == "started"]
        return {
            "received": sum(1 for e in ev if e[1] == "received"),
            "started": len(waits),
            "started_on_time": sum(1 for w in waits if w <= ON_TIME_SEC),
            "started_late": sum(1 for w in waits if w > ON_TIME_SEC),
            "failed_to_start": sum(1 for e in ev if e[1] == "failed"),
            "median_wait_sec": round(statistics.median(waits), 1) if waits else None,
            "max_wait_sec": round(max(waits), 1) if waits else None,
        }

    def stats(self):
        with self.cond:
            now = time.monotonic()
            last = self.window(60.0)
            for who in [w for w, t in self.last_seen.items() if now - t > 60.0]:
                self.last_seen.pop(who, None)
                self.next_slot.pop(who, None)
            return {
                "service": "queue",
                "uptime_sec": int(now - self.born),
                "start_deadline_sec": int(START_DEADLINE_SEC),
                "on_time_sec": int(ON_TIME_SEC),
                "take_limit": "one job per second per dispatcher",
                "waiting": len(self.jobs),
                "oldest_wait_sec": round(now - self.jobs[0][1], 1) if self.jobs else 0.0,
                "dispatchers_seen_10s": sum(1 for t in self.last_seen.values() if now - t <= 10.0),
                "last_60s": last,
                "totals": dict(self.totals),
            }


def run_queue():
    q = JobQueue()

    class H(Handler):
        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/healthz":
                self.reply(200, text="ok\n")
            elif path == "/stats":
                self.reply(200, obj=q.stats())
            elif path == "/":
                self.reply(200, text=QUEUE_HELP)
            else:
                self.reply(404, text="not found\n")

        def do_POST(self):
            self.drain()
            path, _, query = self.path.partition("?")
            if path == "/enqueue":
                m = re.search(r"(?:^|&)id=(\d+)", query)
                if not m:
                    self.reply(400, text="id is required\n")
                    return
                q.enqueue(int(m.group(1)))
                self.reply(200, obj={"queued": int(m.group(1))})
            elif path == "/take":
                job = q.take(self.client_address[0])
                if job is None:
                    self.reply(204)
                else:
                    self.reply(200, obj={"id": job[0], "waited_sec": round(job[1], 2)})
            elif path == "/admin/purge":
                n = q.purge()
                log("WARN", f"purge requested from {self.client_address[0]}: {n} waiting jobs dropped without a start")
                self.reply(200, obj={"purged": n})
            else:
                self.reply(404, text="not found\n")

    serve(8080, H)
    log("INFO", "queue is listening on :8080 (start deadline 20 s, one job per second per dispatcher)")
    while True:
        time.sleep(10)
        with q.cond:
            w = q.window(10.0)
            waiting = len(q.jobs)
            now = time.monotonic()
            seen = sum(1 for t in q.last_seen.values() if now - t <= 10.0)
        median = "-" if w["median_wait_sec"] is None else f"{w['median_wait_sec']:.1f} s"
        bad = w["failed_to_start"] > 0 or (w["median_wait_sec"] or 0) > ON_TIME_SEC
        log("WARN" if bad else "INFO",
            f"10 s: received {w['received']}, started {w['started']} (median wait {median}), "
            f"not started within 20 s: {w['failed_to_start']}, waiting now: {waiting}, dispatchers seen: {seen}")


# ---------------------------------------------------------------------------------------------------------------------
# dispatcher and submitter
# ---------------------------------------------------------------------------------------------------------------------
def queue_addr():
    host, _, port = os.environ.get("QUEUE_ADDR", "queue.runs.svc.cluster.local:8080").partition(":")
    return host, int(port or 8080)


def run_dispatcher():
    host, port = queue_addr()
    log("INFO", f"dispatcher is up, taking jobs from {host}:{port}")
    conn = None
    started, t_report, unreachable = 0, time.monotonic(), 0
    while True:
        try:
            if conn is None:
                conn = http.client.HTTPConnection(host, port, timeout=15)
            conn.request("POST", "/take", body=b"", headers={"Content-Length": "0"})
            resp = conn.getresponse()
            body = resp.read()
            if resp.status == 200:
                job = json.loads(body)
                log("INFO", f"started job {job['id']} (it waited {job['waited_sec']:.1f} s in the queue)")
                started += 1
                time.sleep(0.8)   # bringing a runner up for the job
            elif resp.status != 204:
                raise RuntimeError(f"HTTP {resp.status}")
            unreachable = 0
        except Exception as e:  # noqa: BLE001
            unreachable += 1
            if unreachable == 1 or unreachable % 10 == 0:
                log("WARN", f"queue {host}:{port} is not reachable: {e}")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
            time.sleep(1)
        now = time.monotonic()
        if now - t_report >= 30:
            log("INFO", f"30 s: started {started} jobs ({started / (now - t_report):.2f} per second)")
            started, t_report = 0, now


def run_submitter():
    host, port = queue_addr()
    rate = float(os.environ.get("JOBS_PER_SEC", "6"))
    state = {"submitted_total": 0, "rejected_total": 0, "born": time.monotonic()}

    class H(Handler):
        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/healthz":
                self.reply(200, text="ok\n")
            elif path == "/stats":
                self.reply(200, obj={"service": "submitter", "uptime_sec": int(time.monotonic() - state["born"]),
                                     "jobs_per_sec": rate, "submitted_total": state["submitted_total"],
                                     "rejected_total": state["rejected_total"]})
            else:
                self.reply(404, text="not found\n")

    serve(9090, H)
    log("INFO", f"submitter is up: {rate:g} jobs per second to {host}:{port}")
    jid = 48000
    conn = None
    interval = 1.0 / rate
    next_t = time.monotonic()
    sent, rejected, t_report = 0, 0, time.monotonic()
    while True:
        now = time.monotonic()
        if now < next_t:
            time.sleep(next_t - now)
        next_t += interval
        if next_t < time.monotonic() - 1.0:   # after a stall: catch up with one second of jobs at most
            next_t = time.monotonic() - 1.0
        jid += 1
        try:
            if conn is None:
                conn = http.client.HTTPConnection(host, port, timeout=5)
            conn.request("POST", f"/enqueue?id={jid}", body=b"", headers={"Content-Length": "0"})
            resp = conn.getresponse()
            resp.read()
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            state["submitted_total"] += 1
            sent += 1
        except Exception as e:  # noqa: BLE001
            state["rejected_total"] += 1
            rejected += 1
            if rejected == 1:
                log("WARN", f"queue {host}:{port} did not accept job {jid}: {e}")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
        now = time.monotonic()
        if now - t_report >= 10:
            log("WARN" if rejected else "INFO", f"10 s: submitted {sent} jobs, not accepted by the queue: {rejected}")
            sent, rejected, t_report = 0, 0, now


# ---------------------------------------------------------------------------------------------------------------------
# capacity-controller
# ---------------------------------------------------------------------------------------------------------------------
SELF_NS = "platform"
PLAN_CM = "capacity-plan"
PLAN_KEY = "plan.conf"
HISTORY_CM = "capacity-plan-history"
HISTORY_KEEP = 12
TARGET_NS = "runs"
TARGET = "dispatcher"
POOL_SECTION = "pool dispatcher"
QUEUE_STATS_URL = "http://queue.runs.svc.cluster.local:8080/stats"
INTERVAL_SEC = 10
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
HEADER_RE = re.compile(r"^# revision (\d+), applied (\S+) by capacity-controller\s*$")


def parse_plan(text):
    cp = configparser.ConfigParser(inline_comment_prefixes=("#",), interpolation=None)
    try:
        cp.read_string(text)
    except configparser.Error as e:
        raise ValueError("cannot parse plan.conf: " + str(e).replace("\n", " ")) from None
    if not cp.has_section(POOL_SECTION):
        raise ValueError(f"section [{POOL_SECTION}] is missing")
    sec = cp[POOL_SECTION]

    def integer(key, low, high):
        raw = sec.get(key)
        if raw is None:
            raise ValueError(f"[{POOL_SECTION}] {key} is missing")
        try:
            value = int(raw.strip())
        except ValueError:
            raise ValueError(f"[{POOL_SECTION}] {key} = {raw!r} is not an integer") from None
        if not low <= value <= high:
            raise ValueError(f"[{POOL_SECTION}] {key} = {value} is out of range {low}..{high}")
        return value

    pool = {"min_replicas": integer("min_replicas", 1, 50), "max_replicas": integer("max_replicas", 1, 50),
            "backlog_per_pod": integer("backlog_per_pod", 1, 1000)}
    if pool["min_replicas"] > pool["max_replicas"]:
        raise ValueError(f"[{POOL_SECTION}] min_replicas {pool['min_replicas']} is above max_replicas {pool['max_replicas']}")
    meta = dict(cp["plan"]) if cp.has_section("plan") else {}
    return {"meta": {k: meta.get(k, "").strip() for k in ("generated_at", "sizing_input", "change")}, "pool": pool}


def plan_hash(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()


class Controller:
    def __init__(self):
        self.lock = threading.Lock()
        self.cycles = 0
        self.last_cycle = None
        self.applied = None      # {"revision", "applied_at", "hash", "plan"}
        self.rejected = None     # {"key", "reason"}
        self.pool = {}
        self.last_error = None
        self.warned_no_plan = False
        self.ctx = ssl.create_default_context(cafile=f"{SA_DIR}/ca.crt")
        self.api = "https://{}:{}".format(os.environ.get("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc"),
                                          os.environ.get("KUBERNETES_SERVICE_PORT", "443"))

    # ---- Kubernetes API
    def k8s(self, method, path, body=None, ctype="application/json"):
        with open(f"{SA_DIR}/token") as f:
            token = f.read().strip()
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.api + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", "capacity-controller/1.8")
        if data is not None:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=5) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = json.loads(e.read()).get("message", "")
            except Exception:  # noqa: BLE001
                pass
            err = RuntimeError(f"{method} {path.split('?')[0]}: HTTP {e.code} {detail}".strip())
            err.code = e.code
            raise err from None

    # ---- plan
    def load_history(self):
        try:
            cm = self.k8s("GET", f"/api/v1/namespaces/{SELF_NS}/configmaps/{HISTORY_CM}")
        except RuntimeError as e:
            if getattr(e, "code", 0) == 404:
                return None
            raise
        out = {}
        for key, text in (cm.get("data") or {}).items():
            m = re.fullmatch(r"rev-(\d+)", key)
            if m:
                out[int(m.group(1))] = text
        return out

    def save_history(self, history, revision, entry):
        data = {f"rev-{revision:04d}": entry}
        if history:
            for old in sorted(history)[:max(0, len(history) + 1 - HISTORY_KEEP)]:
                data[f"rev-{old:04d}"] = None
        path = f"/api/v1/namespaces/{SELF_NS}/configmaps"
        if history is None:
            self.k8s("POST", path + "?fieldManager=capacity-controller",
                     {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": HISTORY_CM, "namespace": SELF_NS},
                      "data": {k: v for k, v in data.items() if v is not None}})
        else:
            self.k8s("PATCH", f"{path}/{HISTORY_CM}?fieldManager=capacity-controller", {"data": data},
                     ctype="application/merge-patch+json")

    def reject(self, raw, reason):
        key = hashlib.sha256((raw or "").encode()).hexdigest()
        if self.rejected is None or self.rejected["key"] != key:
            keep = f"; still enforcing revision {self.applied['revision']}" if self.applied else ""
            log("ERROR", f"plan rejected: {reason}{keep}")
        self.rejected = {"key": key, "reason": reason}

    def sync_plan(self):
        raw = None
        try:
            cm = self.k8s("GET", f"/api/v1/namespaces/{SELF_NS}/configmaps/{PLAN_CM}")
            raw = (cm.get("data") or {}).get(PLAN_KEY)
            reason = None if raw is not None else f"ConfigMap {SELF_NS}/{PLAN_CM} has no key {PLAN_KEY}"
        except RuntimeError as e:
            if getattr(e, "code", 0) != 404:
                raise
            reason = f"ConfigMap {SELF_NS}/{PLAN_CM} does not exist"
        plan = None
        if reason is None:
            try:
                plan = parse_plan(raw)
            except ValueError as e:
                reason = str(e)
        if plan is None:
            self.reject(raw, reason)
            if self.applied is None:
                self.adopt_last_applied()
            return
        self.rejected = None
        digest = plan_hash(plan)
        if self.applied and self.applied["hash"] == digest:
            return
        history = self.load_history()
        latest = max(history) if history else 0
        latest_plan, latest_applied_at = None, None
        if latest:
            try:
                latest_plan = parse_plan(history[latest])
            except ValueError:
                latest_plan = None
            m = HEADER_RE.match(history[latest].split("\n", 1)[0])
            latest_applied_at = m.group(2) if m else None
        before = self.applied
        meta = plan["meta"]
        if latest_plan is not None and plan_hash(latest_plan) == digest:
            self.applied = {"revision": latest, "applied_at": latest_applied_at or "unknown", "hash": digest, "plan": plan}
            log("INFO", f"plan revision {latest} is in force: generated_at {meta['generated_at'] or '-'}, "
                        f"change \"{meta['change'] or '-'}\"")
        else:
            revision = latest + 1
            now = utc()
            body = "\n".join(line for line in raw.split("\n") if not HEADER_RE.match(line)).strip("\n") + "\n"
            entry = f"# revision {revision}, applied {now} by capacity-controller\n" + body
            try:
                self.save_history(history, revision, entry)
                saved = f"saved as {HISTORY_CM}/rev-{revision:04d}"
            except RuntimeError as e:
                saved = f"NOT saved to {HISTORY_CM}: {e}"
            self.applied = {"revision": revision, "applied_at": now, "hash": digest, "plan": plan}
            log("INFO", f"plan changed: revision {latest} -> {revision}, generated_at {meta['generated_at'] or '-'}, "
                        f"change \"{meta['change'] or '-'}\"; {saved}")
        if before:
            old, new = before["plan"]["pool"], plan["pool"]
            log("INFO", f"pool dispatcher: bounds {old['min_replicas']}..{old['max_replicas']} -> "
                        f"{new['min_replicas']}..{new['max_replicas']}, backlog_per_pod {old['backlog_per_pod']} -> "
                        f"{new['backlog_per_pod']}")

    def adopt_last_applied(self):
        history = self.load_history()
        for revision in sorted(history or {}, reverse=True):
            try:
                plan = parse_plan(history[revision])
            except ValueError:
                continue
            m = HEADER_RE.match(history[revision].split("\n", 1)[0])
            self.applied = {"revision": revision, "applied_at": m.group(2) if m else "unknown",
                            "hash": plan_hash(plan), "plan": plan}
            log("WARN", f"enforcing the last applied plan, revision {revision}, from {HISTORY_CM}")
            return

    # ---- scaling
    def reconcile(self):
        pool = self.applied["plan"]["pool"]
        revision = self.applied["revision"]
        low, high, per_pod = pool["min_replicas"], pool["max_replicas"], pool["backlog_per_pod"]
        backlog = None
        try:
            with urllib.request.urlopen(QUEUE_STATS_URL, timeout=3) as r:
                backlog = int(json.loads(r.read())["waiting"])
        except Exception as e:  # noqa: BLE001
            log("WARN", f"pool dispatcher: cannot read the queue backlog ({e}); keeping the pool inside its bounds")
        path = f"/apis/apps/v1/namespaces/{TARGET_NS}/deployments/{TARGET}/scale"
        scale = self.k8s("GET", path)
        live = int((scale.get("spec") or {}).get("replicas") or 0)
        want = live if backlog is None else math.ceil(backlog / per_pod)
        desired = min(max(want, low), high)
        limited = "max_replicas" if want > high else ("min_replicas" if want < low else None)
        how = f"backlog {backlog}, want {want} pods (1 per {per_pod} waiting jobs)" if backlog is not None else "backlog unknown"
        note = {"max_replicas": " (limited by max_replicas)", "min_replicas": " (raised to min_replicas)", None: ""}[limited]
        with self.lock:
            self.pool = {"target": f"{TARGET_NS}/deployment/{TARGET}", "min_replicas": low, "max_replicas": high,
                         "backlog_per_pod": per_pod, "backlog": backlog, "want": want, "desired": desired, "live": live,
                         "limited_by": limited}
        if live == desired:
            log("INFO", f"pool dispatcher: {how}, bounds {low}..{high} -> {desired}{note}; deployment/{TARGET} has {live}")
            return
        self.k8s("PATCH", path + "?fieldManager=capacity-controller", {"spec": {"replicas": desired}},
                 ctype="application/merge-patch+json")
        log("INFO", f"pool dispatcher: {how}, bounds {low}..{high} -> {desired}{note}; deployment/{TARGET} has {live}: "
                    f"scaling {live} -> {desired} (plan revision {revision})")
        with self.lock:
            self.pool["live"] = desired
        now = utc()
        try:
            self.k8s("POST", f"/api/v1/namespaces/{TARGET_NS}/events", {
                "apiVersion": "v1", "kind": "Event",
                "metadata": {"generateName": f"{TARGET}.capacity-", "namespace": TARGET_NS},
                "involvedObject": {"apiVersion": "apps/v1", "kind": "Deployment", "name": TARGET, "namespace": TARGET_NS,
                                   "uid": (scale.get("metadata") or {}).get("uid", "")},
                "reason": "CapacityPlanEnforced", "type": "Normal",
                "message": f"replicas {live} -> {desired}: capacity plan revision {revision}, bounds {low}..{high}, {how}",
                "source": {"component": "capacity-controller"},
                "firstTimestamp": now, "lastTimestamp": now, "count": 1})
        except RuntimeError as e:
            log("WARN", f"cannot record an event: {e}")

    def cycle(self):
        self.sync_plan()
        if self.applied is None:
            if not self.warned_no_plan:
                log("WARN", f"no valid plan yet: deployment/{TARGET} is left as it is")
                self.warned_no_plan = True
            return
        self.reconcile()

    def status(self):
        with self.lock:
            applied = self.applied
            plan = None
            if applied:
                plan = {"revision": applied["revision"], "applied_at": applied["applied_at"]}
                plan.update(applied["plan"]["meta"])
            return {
                "service": "capacity-controller",
                "interval_sec": INTERVAL_SEC,
                "cycles": self.cycles,
                "last_cycle_age_sec": None if self.last_cycle is None else round(time.monotonic() - self.last_cycle, 1),
                "plan_in_force": plan,
                "plan_rejected": self.rejected["reason"] if self.rejected else None,
                "pools": {"dispatcher": dict(self.pool)} if self.pool else {},
                "last_error": self.last_error,
            }


def run_controller():
    c = Controller()

    class H(Handler):
        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/healthz":
                self.reply(200, text="ok\n")
            elif path in ("/status", "/stats"):
                self.reply(200, obj=c.status())
            else:
                self.reply(404, text="not found\n")

    serve(8080, H)
    log("INFO", f"capacity-controller 1.8 is up: plan {SELF_NS}/{PLAN_CM} (key {PLAN_KEY}), history {SELF_NS}/{HISTORY_CM}, "
                f"reconcile every {INTERVAL_SEC} s")
    log("INFO", f"pool dispatcher: replicas of {TARGET_NS}/deployment/{TARGET} = "
                "clamp(ceil(waiting jobs / backlog_per_pod), min_replicas, max_replicas)")
    next_t = time.monotonic()
    while True:
        try:
            c.cycle()
            c.last_error = None
        except Exception as e:  # noqa: BLE001
            c.last_error = f"{utc()} {e}"
            log("ERROR", f"reconcile failed: {e}")
        with c.lock:
            c.cycles += 1
            c.last_cycle = time.monotonic()
        next_t += INTERVAL_SEC
        now = time.monotonic()
        if next_t < now:
            next_t = now
        time.sleep(next_t - now)


# ---------------------------------------------------------------------------------------------------------------------
def run_stats(role):
    url = {"queue": "http://127.0.0.1:8080/stats", "submitter": "http://127.0.0.1:9090/stats",
           "controller": "http://127.0.0.1:8080/status"}.get(role)
    if url is None:
        print("this pod has no stats endpoint; see its log", file=sys.stderr)
        return 1
    try:
        with urllib.request.urlopen(url, timeout=4) as r:
            print(json.dumps(json.loads(r.read()), indent=2, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"cannot read {url}: {e}", file=sys.stderr)
        return 1


def main():
    role = os.environ.get("ROLE", "")
    if len(sys.argv) > 1 and sys.argv[1] == "stats":
        sys.exit(run_stats(role))
    if len(sys.argv) > 1:
        role = sys.argv[1]
    signal.signal(signal.SIGTERM, lambda *a: os._exit(0))
    runners = {"queue": run_queue, "dispatcher": run_dispatcher, "submitter": run_submitter, "controller": run_controller}
    if role not in runners:
        print(f"unknown ROLE {role!r}: expected one of {', '.join(sorted(runners))}", file=sys.stderr)
        sys.exit(2)
    runners[role]()


if __name__ == "__main__":
    main()
