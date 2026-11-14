#!/usr/bin/env python3
"""token-sweeper: background cleanup of the authz database.

Removes access tokens that expired before the date in the config and keeps the counters of their integrations in
step. The work is split between workers by integration, so two workers never update the same counter row. A worker
takes a batch of installs and handles it in one transaction: a batch is applied as a whole or not at all.

The sweep is paced so that it does not hurt the cluster. A probe writes a marker row on the primary once a second
and measures how long the marker takes to show up on the standby: that is the replication lag. After every install
a worker waits while the lag is above the limit (or unknown), then pauses for pace_ms.

Pause: create the pause file from the config. The workers commit what they have done and stay idle until it is removed.
"""
import configparser
import os
import signal
import sys
import threading
import time

import psycopg2

CONF = "/etc/token-sweeper/sweeper.conf"

SQL_BATCH = """SELECT i.id, i.integration_id
  FROM installs i JOIN sweep_progress p ON p.integration_id = i.integration_id
 WHERE mod(i.integration_id, %s) = %s AND i.id > p.last_install_id
 ORDER BY i.id LIMIT %s"""
SQL_DELETE = "DELETE FROM access_tokens WHERE install_id = %s AND expires_at < %s"
SQL_COUNTER = "UPDATE integrations SET tokens_stored = tokens_stored - %s, last_swept_at = now() WHERE id = %s"
SQL_PROGRESS = """UPDATE sweep_progress
   SET last_install_id = %s, installs_done = installs_done + 1, tokens_removed = tokens_removed + %s, updated_at = now()
 WHERE integration_id = %s"""
SQL_BEAT = "UPDATE sweep_heartbeat SET seq = seq + 1, beat_at = now() RETURNING seq"
SQL_SEEN = "SELECT seq FROM sweep_heartbeat"
SQL_TOTALS = "SELECT (SELECT count(*) FROM installs), COALESCE(sum(installs_done), 0), COALESCE(sum(tokens_removed), 0) FROM sweep_progress"

STOP = threading.Event()
LOCK = threading.Lock()
STATS = {"checks": 0, "known": 0, "waits": 0, "max_lag": 0.0, "installs": 0, "tokens": 0}
LAG = {"value": None, "at": 0.0}  # the last measurement of the probe and when it was made (monotonic clock)
CONFIG = {}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(level, msg):
    print(f"{now()} token-sweeper: {level} {msg}", flush=True)


def read_conf():
    cp = configparser.ConfigParser()
    if not cp.read(CONF):
        raise SystemExit(f"token-sweeper: cannot read {CONF}")
    return {
        "expired_before": cp.get("sweep", "expired_before"),
        "workers": max(1, cp.getint("sweep", "workers", fallback=4)),
        "batch": max(1, cp.getint("sweep", "batch_installs", fallback=40)),
        "standby_dsn": cp.get("throttle", "standby_dsn"),
        "max_lag": cp.getfloat("throttle", "max_replica_lag_sec", fallback=5.0),
        "pace": max(0.0, cp.getfloat("throttle", "pace_ms", fallback=1500) / 1000.0),
        "report": max(2.0, cp.getfloat("throttle", "report_sec", fallback=10)),
        "pause_file": cp.get("control", "pause_file", fallback="/var/lib/token-sweeper/pause"),
        "dsn": cp.get("database", "dsn"),
    }


def first_line(e):
    text = (getattr(e, "pgerror", None) or str(e) or e.__class__.__name__).strip()
    return " ".join(text.splitlines()[0].split()) if text else e.__class__.__name__


def paused():
    return os.path.exists(CONFIG["pause_file"])


def close(conn):
    if conn is not None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def publish_lag(value):
    with LOCK:
        LAG["value"] = value
        LAG["at"] = time.monotonic()


def current_lag():
    """The lag the probe measured last; None when the probe has had nothing to say for five seconds."""
    with LOCK:
        if LAG["value"] is None or time.monotonic() - LAG["at"] > 5:
            return None
        return LAG["value"]


class LagProbe(threading.Thread):
    """Replication lag as a client sees it: a marker is written on the primary and awaited on the standby."""

    def __init__(self):
        super().__init__(daemon=True, name="lag-probe")
        self.last_error_log = 0.0

    def run(self):
        while not STOP.is_set():
            primary = standby = None
            try:
                primary = psycopg2.connect(CONFIG["dsn"], application_name="token-sweeper lag probe")
                primary.autocommit = True
                standby = psycopg2.connect(CONFIG["standby_dsn"], application_name="token-sweeper lag probe")
                standby.autocommit = True
                self.measure(primary.cursor(), standby.cursor())
            except psycopg2.Error as e:
                publish_lag(None)
                if time.monotonic() - self.last_error_log > 10:
                    self.last_error_log = time.monotonic()
                    log("ERROR", f"lag probe: {first_line(e)}; the lag is unknown, reconnecting")
            finally:
                close(primary)
                close(standby)
            STOP.wait(2)

    def measure(self, primary, standby):
        while not STOP.is_set():
            started = time.monotonic()
            primary.execute(SQL_BEAT)
            seq = primary.fetchone()[0]
            while not STOP.is_set():
                standby.execute(SQL_SEEN)
                seen = standby.fetchone()[0]
                elapsed = time.monotonic() - started
                publish_lag(elapsed)
                if seen >= seq:
                    break
                STOP.wait(0.02 if elapsed < 1 else 0.2)
            STOP.wait(1)


class Worker(threading.Thread):
    def __init__(self, index):
        super().__init__(daemon=True, name=f"worker-{index}")
        self.index = index
        self.idle_logged = False
        self.pause_logged = False
        self.last_wait_log = 0.0

    def run(self):
        while not STOP.is_set():
            conn = None
            try:
                conn = psycopg2.connect(CONFIG["dsn"], application_name=f"token-sweeper worker {self.index}")
                log("INFO", f"worker {self.index}: connected to the primary")
                self.work(conn)
            except psycopg2.Error as e:
                log("ERROR", f"worker {self.index}: database error: {first_line(e)}; the open batch is lost, reconnecting in 2 s")
            finally:
                close(conn)
            STOP.wait(2)

    def throttle(self):
        """The safeguard: wait while the standby is behind, then pace."""
        while not STOP.is_set():
            lag = current_lag()
            with LOCK:
                STATS["checks"] += 1
                if lag is not None:
                    STATS["known"] += 1
                    STATS["max_lag"] = max(STATS["max_lag"], lag)
            if lag is not None and lag <= CONFIG["max_lag"]:
                break
            with LOCK:
                STATS["waits"] += 1
            if time.monotonic() - self.last_wait_log > 10:
                self.last_wait_log = time.monotonic()
                what = "replication lag is unknown" if lag is None else f"replication lag {lag:.1f} s is above the limit {CONFIG['max_lag']:g} s"
                log("WARN", f"throttle: {what}: worker {self.index} waits")
            STOP.wait(1)
        STOP.wait(CONFIG["pace"])

    def work(self, conn):
        cur = conn.cursor()
        while not STOP.is_set():
            if paused():
                conn.rollback()
                if not self.pause_logged:
                    self.pause_logged = True
                    log("INFO", f"worker {self.index}: paused ({CONFIG['pause_file']} exists), no open transaction")
                STOP.wait(1)
                continue
            if self.pause_logged:
                self.pause_logged = False
                log("INFO", f"worker {self.index}: pause file removed, resuming")
            cur.execute(SQL_BATCH, (CONFIG["workers"], self.index, CONFIG["batch"]))
            batch = cur.fetchall()
            if not batch:
                conn.rollback()
                if not self.idle_logged:
                    self.idle_logged = True
                    log("INFO", f"worker {self.index}: nothing left to sweep")
                STOP.wait(30)
                continue
            done = removed = 0
            for install_id, integration_id in batch:
                cur.execute(SQL_DELETE, (install_id, CONFIG["expired_before"]))
                n = cur.rowcount
                cur.execute(SQL_COUNTER, (n, integration_id))
                cur.execute(SQL_PROGRESS, (install_id, n, integration_id))
                done += 1
                removed += n
                self.throttle()
                if STOP.is_set():
                    return  # the open batch is rolled back when the session closes
                if paused():
                    break
            conn.commit()
            with LOCK:
                STATS["installs"] += done
                STATS["tokens"] += removed
            log("INFO", f"worker {self.index}: batch committed: {done} installs, {removed} expired tokens removed")


def totals():
    while not STOP.is_set():
        conn = None
        try:
            conn = psycopg2.connect(CONFIG["dsn"], application_name="token-sweeper")
            with conn.cursor() as cur:
                cur.execute(SQL_TOTALS)
                return cur.fetchone()
        except psycopg2.Error as e:
            log("ERROR", f"cannot read the progress of the sweep: {first_line(e)}; retrying in 2 s")
            STOP.wait(2)
        finally:
            close(conn)
    return (0, 0, 0)


def main():
    CONFIG.update(read_conf())
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    total, done0, removed0 = totals()
    log("INFO", f"sweep of access tokens expired before {CONFIG['expired_before']} started: {done0} of {total} installs "
                f"already swept, {CONFIG['workers']} workers, {CONFIG['batch']} installs per transaction")
    log("INFO", f"throttle: replication lag limit {CONFIG['max_lag']:g} s, pace {int(CONFIG['pace'] * 1000)} ms after every install")
    log("INFO", f"to pause the sweep create {CONFIG['pause_file']}, to resume remove it")
    LagProbe().start()
    waited = 0
    while current_lag() is None and waited < 50 and not STOP.wait(0.1):
        waited += 1  # the first measurement of the probe
    for index in range(CONFIG["workers"]):
        Worker(index).start()
    while not STOP.wait(CONFIG["report"]):
        with LOCK:
            checks, known, waits, max_lag = STATS["checks"], STATS["known"], STATS["waits"], STATS["max_lag"]
            STATS["checks"] = STATS["known"] = STATS["waits"] = 0
            STATS["max_lag"] = 0.0
            done, removed = done0 + STATS["installs"], removed0 + STATS["tokens"]
        if checks == 0:
            continue  # paused or nothing left: no work, nothing to report
        verdict = "OK, the sweep continues" if waits == 0 else f"{waits} checks not passed, the workers waited"
        measured = f"{max_lag:.1f} s" if known else "unknown"
        log("INFO", f"throttle: replication lag {measured} (limit {CONFIG['max_lag']:g} s), "
                    f"{checks} checks in {CONFIG['report']:g} s: {verdict}; committed so far: {done} of {total} installs, "
                    f"{removed} tokens removed")
    log("INFO", "stopping: open batches are rolled back by the database")
    time.sleep(0.2)


if __name__ == "__main__":
    main()
    sys.exit(0)
