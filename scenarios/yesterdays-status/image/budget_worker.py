#!/usr/bin/env python3
"""budget-worker: applies budget updates from the queue to PostgreSQL and keeps the cached access status in Redis.

Events (JSON, one per list element of queue:budget-updates, oldest first):

  usage         a usage record of a gateway node: {"seq", "type": "usage", "customer", "amount_cents", "at",
                "queued_at", "node"} and, when the node already refuses the customer, the budget state it measured:
                "budget_state": "exhausted", "spent_cents", "limit_cents".
                The amount goes to the ledger and to the counter of the period the record belongs to: the current
                period (usage_current) or, for a record delivered after the reset, the closed one (usage_history).
  limit_change  the customer changed the monthly budget: {"seq", "type": "limit_change", "customer",
                "new_limit_cents", "at", "queued_at"}.

After an event the access status of the customer is written to Redis (access:<customer>): the state reported by the
gateway when the record carries one, otherwise the status computed from the current budget data.

Settings come from settingsd (namespace budget-worker) and are refreshed while the worker runs; the [overrides]
section of the local file wins over them.
"""
import configparser
import datetime
import json
import signal
import time
import urllib.request

import psycopg2
import redis

VERSION = "2.8.0"
CONF = "/etc/budget-worker/worker.conf"
DEFAULTS = {
    "queue.batch_size": 2,
    "queue.poll_interval_ms": 1000,
    "access.status_ttl_sec": 21600,
    "access.discard_state_before_reset": False,
}
UTC = datetime.timezone.utc


def iso(ts):
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def now():
    return datetime.datetime.now(UTC)


def parse_ts(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def log(level, msg):
    print("%s %s %s" % (iso(now()), level, msg), flush=True)


def coerce(key, value):
    default = DEFAULTS[key]
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off"):
            return False
        raise ValueError("%s: not a boolean: %r" % (key, value))
    return int(value)


def show(settings):
    return " ".join("%s=%s" % (k, str(settings[k]).lower() if isinstance(settings[k], bool) else settings[k]) for k in DEFAULTS)


def waited(event):
    try:
        minutes = int((now() - parse_ts(event["queued_at"])).total_seconds() // 60)
    except Exception:
        return ""
    return " (waited %d min in the queue)" % minutes if minutes >= 1 else ""


class Worker:
    def __init__(self, conf):
        self.conf = conf
        self.dsn = conf.get("database", "dsn")
        self.queue = conf.get("redis", "queue", fallback="queue:budget-updates")
        self.processing = self.queue + ":processing"
        self.dead = self.queue + ":dead"
        self.redis = redis.Redis(host=conf.get("redis", "host", fallback="127.0.0.1"),
                                 port=conf.getint("redis", "port", fallback=6379),
                                 socket_timeout=3, socket_connect_timeout=3, decode_responses=True)
        self.settings_url = "%s/v1/settings/%s" % (conf.get("settings", "url", fallback="http://127.0.0.1:8500").rstrip("/"),
                                                   conf.get("settings", "namespace", fallback="budget-worker"))
        self.refresh_sec = conf.getfloat("settings", "refresh_sec", fallback=15.0)
        self.overrides = {}
        if conf.has_section("overrides"):
            for key, value in conf.items("overrides"):
                if key in DEFAULTS:
                    self.overrides[key] = coerce(key, value)
                else:
                    log("WARN", "unknown key in [overrides] of %s: %s" % (CONF, key))
        self.settings = dict(DEFAULTS)
        self.settings.update(self.overrides)
        self.remote_ok = None
        self.next_refresh = 0.0
        self.next_stats = time.monotonic() + 60
        self.db = None
        self.periods = None
        self.periods_until = 0.0
        self.stopping = False

    # ---- settings -------------------------------------------------------------------------------------------------
    def refresh_settings(self, first=False):
        self.next_refresh = time.monotonic() + self.refresh_sec
        fresh = dict(DEFAULTS)
        try:
            with urllib.request.urlopen(self.settings_url, timeout=3) as resp:
                remote = json.load(resp).get("values", {})
            for key in DEFAULTS:
                if key in remote:
                    fresh[key] = coerce(key, remote[key])
            if self.remote_ok is False:
                log("INFO", "settings service %s answers again" % self.settings_url)
            self.remote_ok = True
        except Exception as exc:
            if self.remote_ok is not False:
                log("WARN", "settings service %s is unavailable (%s): %s" % (
                    self.settings_url, exc, "built-in defaults in use" if first else "the last known values stay"))
            self.remote_ok = False
            if not first:
                return
        fresh.update(self.overrides)
        if first:
            log("INFO", "settings (%s): %s" % (self.settings_url, show(fresh)))
            if self.overrides:
                log("INFO", "local overrides from %s: %s" % (CONF, ", ".join(sorted(self.overrides))))
        else:
            for key in DEFAULTS:
                if fresh[key] != self.settings[key]:
                    log("INFO", "settings changed: %s %s -> %s" % (key, str(self.settings[key]).lower(), str(fresh[key]).lower()))
        self.settings = fresh

    # ---- database -------------------------------------------------------------------------------------------------
    def cursor(self):
        if self.db is None or self.db.closed:
            self.db = psycopg2.connect(self.dsn)
        return self.db.cursor()

    def load_periods(self, cur):
        if self.periods is None or time.monotonic() > self.periods_until:
            cur.execute("SELECT period, started_at FROM billing_periods ORDER BY started_at DESC LIMIT 2")
            self.periods = cur.fetchall()
            self.periods_until = time.monotonic() + 2
        return self.periods

    # ---- cache ----------------------------------------------------------------------------------------------------
    def save_status(self, customer, allowed, spent, limit, as_of, source):
        status = {"allowed": allowed, "reason": "ok" if allowed else "budget_exhausted", "spent_cents": spent,
                  "limit_cents": limit, "as_of": as_of, "source": source}
        self.redis.set("access:%d" % customer, json.dumps(status), ex=self.settings["access.status_ttl_sec"])

    # ---- events ---------------------------------------------------------------------------------------------------
    def apply_usage(self, ev):
        seq, customer, amount = int(ev["seq"]), int(ev["customer"]), int(ev["amount_cents"])
        at = parse_ts(ev["at"])
        cur = self.cursor()
        periods = self.load_periods(cur)
        current, started = periods[0]
        late = at < started
        cur.execute("INSERT INTO usage_ledger (seq, customer_id, amount_cents, at, node) VALUES (%s, %s, %s, %s, %s) "
                    "ON CONFLICT (seq) DO NOTHING RETURNING seq", (seq, customer, amount, at, ev.get("node")))
        if cur.fetchone() is None:
            self.db.commit()
            log("WARN", "seq=%d usage customer=%d: already applied, skipped" % (seq, customer))
            return
        spent = limit = None
        if late:
            closed = periods[1][0] if len(periods) > 1 else None
            cur.execute("UPDATE usage_history SET spent_cents = spent_cents + %s WHERE period = %s AND customer_id = %s",
                        (amount, closed, customer))
        else:
            cur.execute("UPDATE usage_current SET spent_cents = spent_cents + %s, updated_at = now() "
                        "WHERE customer_id = %s RETURNING spent_cents", (amount, customer))
            row = cur.fetchone()
            cur.execute("SELECT limit_cents FROM budgets WHERE customer_id = %s", (customer,))
            lim = cur.fetchone()
            if row is None or lim is None:
                self.db.rollback()
                log("WARN", "seq=%d usage: unknown customer %d, event dropped" % (seq, customer))
                return
            spent, limit = row[0], lim[0]
        self.db.commit()

        head = "seq=%d usage customer=%d amount=%d at=%s" % (seq, customer, amount, ev["at"])
        if late:
            log("INFO", "%s -> late record, posted to period %s" % (head, periods[1][0] if len(periods) > 1 else "?"))
        if ev.get("budget_state") == "exhausted":
            g_spent, g_limit = int(ev.get("spent_cents", 0)), int(ev.get("limit_cents", 0))
            said = "seq=%d customer=%d: gateway %s reports budget_state=exhausted (%d of %d) as of %s" % (
                seq, customer, ev.get("node", "?"), g_spent, g_limit, ev["at"])
            if late and self.settings["access.discard_state_before_reset"]:
                log("INFO", "%s, measured before the reset of %s: state discarded" % (said, iso(started)))
            else:
                self.save_status(customer, False, g_spent, g_limit, ev["at"], "gateway %s, seq %d" % (ev.get("node", "?"), seq))
                log("INFO", "%s, access status saved: blocked" % said)
        elif not late:
            allowed = spent < limit
            self.save_status(customer, allowed, spent, limit, iso(now()), "budget-worker, seq %d" % seq)
            log("INFO", "%s -> spent %d of %d, access %s" % (head, spent, limit, "allowed" if allowed else "blocked"))

    def apply_limit(self, ev):
        seq, customer, new_limit = int(ev["seq"]), int(ev["customer"]), int(ev["new_limit_cents"])
        cur = self.cursor()
        cur.execute("SELECT limit_cents FROM budgets WHERE customer_id = %s FOR UPDATE", (customer,))
        row = cur.fetchone()
        if row is None:
            self.db.rollback()
            log("WARN", "seq=%d limit_change: unknown customer %d, event dropped" % (seq, customer))
            return
        old_limit = row[0]
        cur.execute("INSERT INTO budget_changes (seq, customer_id, old_limit_cents, new_limit_cents, requested_at) "
                    "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (seq) DO NOTHING RETURNING seq",
                    (seq, customer, old_limit, new_limit, parse_ts(ev["at"])))
        if cur.fetchone() is None:
            self.db.commit()
            log("WARN", "seq=%d limit_change customer=%d: already applied, skipped" % (seq, customer))
            return
        cur.execute("UPDATE budgets SET limit_cents = %s, updated_at = now() WHERE customer_id = %s", (new_limit, customer))
        cur.execute("SELECT spent_cents FROM usage_current WHERE customer_id = %s", (customer,))
        spent = cur.fetchone()[0]
        self.db.commit()
        allowed = spent < new_limit
        self.save_status(customer, allowed, spent, new_limit, iso(now()), "budget-worker, seq %d" % seq)
        log("INFO", "seq=%d limit_change customer=%d %d -> %d requested at %s%s -> spent %d of %d, access %s" % (
            seq, customer, old_limit, new_limit, ev["at"], waited(ev), spent, new_limit, "allowed" if allowed else "blocked"))

    def handle(self, raw):
        try:
            ev = json.loads(raw)
            kind = ev["type"]
            if kind not in ("usage", "limit_change"):
                raise ValueError("unknown event type %r" % kind)
        except (ValueError, KeyError, TypeError) as exc:
            self.redis.rpush(self.dead, raw)
            log("ERROR", "unreadable event moved to %s: %s" % (self.dead, exc))
            return
        try:
            if kind == "usage":
                self.apply_usage(ev)
            else:
                self.apply_limit(ev)
        except (KeyError, ValueError, TypeError) as exc:
            if self.db is not None and not self.db.closed:
                self.db.rollback()
            self.redis.rpush(self.dead, raw)
            log("ERROR", "malformed %s event moved to %s: %s" % (kind, self.dead, exc))

    # ---- main loop ------------------------------------------------------------------------------------------------
    def requeue_unfinished(self):
        moved = 0
        while self.redis.lmove(self.processing, self.queue, "RIGHT", "LEFT") is not None:
            moved += 1
        if moved:
            log("WARN", "%d event(s) left in %s by the previous run are back at the head of the queue" % (moved, self.processing))

    def stats(self):
        self.next_stats = time.monotonic() + 60
        length = self.redis.llen(self.queue)
        if not length:
            log("INFO", "queue %s: empty" % self.queue)
            return
        note = ""
        try:
            oldest = json.loads(self.redis.lindex(self.queue, 0))
            note = ", the oldest was queued %d min ago" % int((now() - parse_ts(oldest["queued_at"])).total_seconds() // 60)
        except Exception:
            pass
        log("INFO", "queue %s: %d events waiting%s" % (self.queue, length, note))

    def run(self):
        log("INFO", "budget-worker %s started, queue %s" % (VERSION, self.queue))
        self.refresh_settings(first=True)
        recovered = False
        while not self.stopping:
            try:
                if not recovered:
                    self.requeue_unfinished()
                    self.stats()
                    recovered = True
                if time.monotonic() >= self.next_refresh:
                    self.refresh_settings()
                if time.monotonic() >= self.next_stats:
                    self.stats()
                done = 0
                while done < self.settings["queue.batch_size"] and not self.stopping:
                    raw = self.redis.lmove(self.queue, self.processing, "LEFT", "RIGHT")
                    if raw is None:
                        break
                    self.handle(raw)
                    self.redis.lrem(self.processing, 1, raw)
                    done += 1
            except (redis.RedisError, psycopg2.Error) as exc:
                log("ERROR", "%s: %s; retrying in 3 s" % (type(exc).__name__, str(exc).strip().splitlines()[0] if str(exc).strip() else ""))
                try:
                    if self.db is not None:
                        self.db.close()
                except Exception:
                    pass
                self.db = None
                recovered = False
                self.pause(3.0)
                continue
            self.pause(self.settings["queue.poll_interval_ms"] / 1000.0)
        log("INFO", "budget-worker stopped")

    def pause(self, seconds):
        deadline = time.monotonic() + seconds
        while not self.stopping and time.monotonic() < deadline:
            time.sleep(0.05)


def main():
    conf = configparser.ConfigParser()
    conf.optionxform = str
    conf.read(CONF)
    worker = Worker(conf)
    signal.signal(signal.SIGTERM, lambda *_: setattr(worker, "stopping", True))
    worker.run()


if __name__ == "__main__":
    main()
