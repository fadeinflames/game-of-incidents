#!/usr/bin/env python3
"""jobrunner: a pool of worker threads that runs background jobs from Redis queues.

One dispatcher thread takes jobs from the queues and hands them to idle workers. A job that is taken from a queue
is kept in the list `jobrunner:inflight` until its worker reports the result, so a restart never loses a job:
whatever is left in that list goes back to its queue on the next start.

Configuration: /etc/jobrunner/jobrunner.yml (pool size, Redis, the application) and the limits file it names.
Documentation: /usr/share/doc/jobrunner/README
"""
import collections
import ctypes
import importlib.util
import json
import os
import queue
import random
import signal
import sys
import threading
import time

import redis
import yaml

VERSION = "2.9.4"
CONFIG = os.environ.get("JOBRUNNER_CONFIG", "/etc/jobrunner/jobrunner.yml")
INFLIGHT = "jobrunner:inflight"
DEAD = "jobrunner:dead"
STATE = "jobrunner:state"
STATS_EVERY = 10.0
FAILURE_LINES_PER_WINDOW = 5
STOP_GRACE = 12.0

_log_lock = threading.Lock()


def log(msg):
    line = "%s jobrunner[%d]: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), os.getpid(), msg)
    with _log_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


class Drop(Exception):
    """Raised by a job that cannot be done and must not be retried."""


class ConfigError(Exception):
    pass


def set_thread_name(name):
    try:
        ctypes.CDLL(None, use_errno=True).prctl(15, name.encode()[:15], 0, 0, 0)  # PR_SET_NAME
    except Exception:
        pass


def read_yaml(path):
    try:
        with open(path, encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except OSError as e:
        raise ConfigError("%s: %s" % (path, e.strerror))
    except yaml.YAMLError as e:
        raise ConfigError("%s: not valid YAML: %s" % (path, " ".join(str(e).split())))
    if doc is None:
        return {}
    if not isinstance(doc, dict):
        raise ConfigError("%s: the top level must be a mapping" % path)
    return doc


def read_limits(path):
    raw = read_yaml(path).get("limits") or {}
    if not isinstance(raw, dict):
        raise ConfigError("%s: 'limits' must be a mapping of queue name to number" % path)
    limits = {}
    for name, value in raw.items():
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ConfigError("%s: the limit of '%s' must be a whole number, 0 or more" % (path, name))
        limits[str(name)] = value
    return limits


class Context:
    """What a job function gets besides the job itself."""

    def __init__(self, runner):
        self.settings = runner.cfg
        self._runner = runner

    def enqueue(self, queue_name, cls, **args):
        doc = {"jid": os.urandom(6).hex(), "class": cls, "queue": queue_name, "args": args}
        self._runner.redis.lpush(queue_name, json.dumps(doc, separators=(",", ":")))


class Runner:
    def __init__(self):
        self.cfg = read_yaml(CONFIG)
        pool = self.cfg.get("pool") or {}
        self.concurrency = pool.get("concurrency", 8)
        if isinstance(self.concurrency, bool) or not isinstance(self.concurrency, int) or not 1 <= self.concurrency <= 512:
            raise ConfigError("%s: pool.concurrency must be a whole number from 1 to 512" % CONFIG)
        self.limits_file = self.cfg.get("limits_file", "/etc/jobrunner/limits.yml")
        app_path = self.cfg.get("app")
        if not app_path:
            raise ConfigError("%s: 'app' (the file that declares queues and jobs) is not set" % CONFIG)
        spec = importlib.util.spec_from_file_location("jobrunner_app", app_path)
        if spec is None:
            raise ConfigError("%s: cannot load the application %s" % (CONFIG, app_path))
        self.app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.app)
        self.app.Drop = Drop
        self.app_path = app_path
        self.queues = list(self.app.QUEUES)
        self.jobs = dict(self.app.JOBS)
        rcfg = self.cfg.get("redis") or {}
        self.redis_addr = "%s:%s" % (rcfg.get("host", "127.0.0.1"), rcfg.get("port", 6379))
        self.redis = redis.Redis(host=rcfg.get("host", "127.0.0.1"), port=int(rcfg.get("port", 6379)),
                                 socket_timeout=5, socket_connect_timeout=3, decode_responses=True)
        self.ctx = Context(self)
        self.lock = threading.Lock()
        self.limits = {}
        self.limit_entries = 0
        self.inflight = {q: 0 for q in self.queues}
        self.idle = self.concurrency
        self.backing_off = 0
        self.peak_busy = 0
        self.handoff = queue.Queue()
        self.stopping = False
        self.want_reload = False
        self.rr = 0
        self.started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.counters = collections.Counter()
        self.done_by_class = collections.Counter()
        self.failure_lines = 0
        self.last_stats = time.monotonic()
        self.last_beat = 0.0
        self.last_redis_error = 0.0

    # ---- configuration -------------------------------------------------------------------------------------------

    def apply_limits(self):
        entries = read_limits(self.limits_file)
        with self.lock:
            self.limits = {q: entries[q] for q in self.queues if q in entries}
            self.limit_entries = len(entries)

    def describe_queues(self):
        parts = []
        for q in self.queues:
            limit = self.limits.get(q)
            parts.append("%s (%s)" % (q, "no limit" if limit is None else "paused" if limit == 0 else "limit %d" % limit))
        return "listening on %d queues: %s" % (len(self.queues), ", ".join(parts))

    def reload(self):
        self.want_reload = False
        try:
            self.apply_limits()
        except ConfigError as e:
            log("reload failed: %s; the previous limits stay in effect" % e)
            return
        log("reload: %d entries loaded from %s" % (self.limit_entries, self.limits_file))
        log(self.describe_queues())

    # ---- Redis ---------------------------------------------------------------------------------------------------

    def redis_trouble(self, e):
        now = time.monotonic()
        if now - self.last_redis_error >= 5:
            self.last_redis_error = now
            log("redis %s is not available: %s" % (self.redis_addr, " ".join(str(e).split())))

    def recover(self):
        """Jobs the previous run had taken and not finished go back to the front of their queues."""
        while not self.stopping:
            try:
                left = self.redis.lrange(INFLIGHT, 0, -1)
                if left:
                    pipe = self.redis.pipeline(transaction=True)
                    for raw in left:
                        try:
                            target = json.loads(raw)["queue"]
                        except Exception:
                            target = DEAD
                        pipe.rpush(target, raw)
                    pipe.delete(INFLIGHT)
                    pipe.execute()
                    log("recovered %d jobs left in flight by the previous run: returned to their queues" % len(left))
                return
            except redis.RedisError as e:
                self.redis_trouble(e)
                time.sleep(1)

    def settle(self, q, raw, outcome):
        """Report the result of a job to Redis. Retries until Redis takes it: the job must not vanish."""
        while True:
            try:
                pipe = self.redis.pipeline(transaction=True)
                if outcome == "retry":
                    pipe.rpush(q, raw)
                elif outcome == "dead":
                    pipe.lpush(DEAD, raw)
                pipe.lrem(INFLIGHT, 1, raw)
                pipe.execute()
                return
            except redis.RedisError as e:
                self.redis_trouble(e)
                if self.stopping:
                    return
                time.sleep(1)

    # ---- workers -------------------------------------------------------------------------------------------------

    def failure(self, name, cls, args, e):
        with self.lock:
            self.counters["failed"] += 1
            self.counters["requeued"] += 1
            self.failure_lines += 1
            quiet = self.failure_lines > FAILURE_LINES_PER_WINDOW
            if quiet:
                self.counters["suppressed"] += 1
        if not quiet:
            log("[%s] failed %s %s: %s: %s; the job goes back to its queue" % (name, cls, args, type(e).__name__, " ".join(str(e).split())))

    def run_job(self, name, q, raw):
        try:
            job = json.loads(raw)
            cls = job["class"]
            fn = self.jobs[cls]
            args = " ".join("%s=%s" % (k, v) for k, v in job.get("args", {}).items())
        except Exception:
            log("[%s] a job on %s cannot be read, moved to %s" % (name, q, DEAD))
            return "dead"
        t0 = time.monotonic()
        try:
            fn(job, self.ctx)
        except Drop as e:
            log("[%s] dropped %s %s: %s" % (name, cls, args, e))
            with self.lock:
                self.counters["dropped"] += 1
            return "done"
        except Exception as e:  # noqa: BLE001  whatever went wrong, the job is tried again
            self.failure(name, cls, args, e)
            return "retry"
        took = time.monotonic() - t0
        with self.lock:
            self.counters["done"] += 1
            self.done_by_class[cls] += 1
        if took >= 1.0:
            log("[%s] done %s %s in %.1fs" % (name, cls, args, took))
        return "done"

    def worker(self, n):
        name = "worker-%03d" % n
        set_thread_name(name)
        while True:
            item = self.handoff.get()
            if item is None:
                return
            q, raw = item
            outcome = self.run_job(name, q, raw)
            self.settle(q, raw, outcome)
            with self.lock:
                self.inflight[q] -= 1
                if outcome == "retry":
                    self.backing_off += 1
            if outcome == "retry":
                # do not hammer whatever has just failed
                time.sleep(random.uniform(0.3, 0.8))
            with self.lock:
                if outcome == "retry":
                    self.backing_off -= 1
                self.idle += 1

    # ---- dispatcher ----------------------------------------------------------------------------------------------

    def dispatch(self):
        handed = 0
        order = self.queues[self.rr:] + self.queues[:self.rr]
        self.rr = (self.rr + 1) % len(self.queues)
        for q in order:
            with self.lock:
                if self.idle <= 0:
                    break
                limit = self.limits.get(q)
                if limit is not None and self.inflight[q] >= limit:
                    continue
                self.inflight[q] += 1
                self.idle -= 1
            raw = None
            try:
                raw = self.redis.rpoplpush(q, INFLIGHT)
            finally:
                if raw is None:
                    with self.lock:
                        self.inflight[q] -= 1
                        self.idle += 1
            if raw is not None:
                self.handoff.put((q, raw))
                handed += 1
        with self.lock:
            busy = self.concurrency - self.idle
            if busy > self.peak_busy:
                self.peak_busy = busy
        return handed

    def heartbeat(self):
        now = time.monotonic()
        if now - self.last_beat >= 1.0:
            self.last_beat = now
            with self.lock:
                state = {
                    "pid": os.getpid(), "version": VERSION, "started": self.started, "concurrency": self.concurrency,
                    "busy": self.concurrency - self.idle, "backing_off": self.backing_off,
                    "queues": {q: {"in_flight": self.inflight[q], "limit": self.limits.get(q)} for q in self.queues},
                }
            self.redis.set(STATE, json.dumps(state), ex=5)
        if now - self.last_stats >= STATS_EVERY:
            self.last_stats = now
            with self.lock:
                c, by_class, peak = self.counters, self.done_by_class, self.peak_busy
                self.counters, self.done_by_class = collections.Counter(), collections.Counter()
                self.failure_lines = 0
                self.peak_busy = self.concurrency - self.idle
            if c:
                classes = " ".join("%s=%d" % kv for kv in sorted(by_class.items()))
                line = "stats %ds: done=%d%s failed=%d requeued=%d peak_busy=%d/%d" % (
                    STATS_EVERY, c["done"], " (%s)" % classes if classes else "", c["failed"], c["requeued"], peak, self.concurrency)
                if c["dropped"]:
                    line += " dropped=%d" % c["dropped"]
                if c["suppressed"]:
                    line += " (%d more failure lines not printed)" % c["suppressed"]
                log(line)

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stopping", True))
        signal.signal(signal.SIGINT, lambda *_: setattr(self, "stopping", True))
        signal.signal(signal.SIGHUP, lambda *_: setattr(self, "want_reload", True))
        self.apply_limits()
        log("starting: jobrunner %s, pool concurrency=%d, app %s, redis %s" % (VERSION, self.concurrency, self.app_path, self.redis_addr))
        log("limits: %d entries loaded from %s" % (self.limit_entries, self.limits_file))
        log(self.describe_queues())
        set_thread_name("dispatcher")
        self.recover()
        threads = [threading.Thread(target=self.worker, args=(n,), daemon=True) for n in range(1, self.concurrency + 1)]
        for t in threads:
            t.start()
        while not self.stopping:
            try:
                if self.want_reload:
                    self.reload()
                handed = self.dispatch()
                self.heartbeat()
            except redis.RedisError as e:
                self.redis_trouble(e)
                time.sleep(1)
                continue
            if not handed:
                time.sleep(0.1)
        with self.lock:
            busy = self.concurrency - self.idle
        log("stopping: %d jobs in flight, waiting up to %d s for them" % (busy, STOP_GRACE))
        for _ in threads:
            self.handoff.put(None)
        deadline = time.monotonic() + STOP_GRACE
        while time.monotonic() < deadline and any(t.is_alive() for t in threads):
            time.sleep(0.2)
        left = sum(1 for t in threads if t.is_alive())
        try:
            self.redis.delete(STATE)
        except redis.RedisError:
            pass
        log("stopped" if not left else "stopped with %d jobs unfinished: they return to their queues on the next start" % left)
        sys.stdout.flush()
        os._exit(0)


def main():
    try:
        Runner().run()
    except ConfigError as e:
        log("cannot start: %s" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
