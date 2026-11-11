#!/usr/bin/env python3
"""billing-worker: rates usage events and keeps the in-flight account balances in Redis.

For every usage event (a message or a call):
  1. read the account balance from the balances primary;
  2. write the usage to the ledger (the relational double-bookkeeping record), then decrement the balance;
  3. if the account has auto-recharge and the balance is below its threshold: charge the card through the card
     processor, write the recharge to the ledger, then credit the balance.

The usage feed of the platform is replaced by a generator inside the worker: one event per tick.
"""
import configparser
import json
import random
import signal
import sqlite3
import time
import urllib.request

import redis

CONF = "/etc/billing/worker.conf"


def log(level, msg):
    print("%s %s %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), level, msg), flush=True)


def redis_error(exc):
    if isinstance(exc, redis.exceptions.ReadOnlyError):
        return "READONLY %s" % exc
    return str(exc) or type(exc).__name__


class Worker:
    def __init__(self, conf):
        self.tick = conf.getfloat("worker", "tick_sec", fallback=1.0)
        self.cardproc = conf.get("cardproc", "url", fallback="http://127.0.0.1:8090").rstrip("/")
        self.redis = redis.Redis(
            host=conf.get("redis", "host", fallback="127.0.0.1"), port=conf.getint("redis", "port", fallback=6379),
            socket_timeout=2, socket_connect_timeout=2, decode_responses=True)
        self.db = sqlite3.connect(conf.get("ledger", "path", fallback="/var/lib/billing/billing.db"),
                                  timeout=10, isolation_level=None)
        self.accounts = {
            row[0]: {"id": row[0], "auto": bool(row[1]), "threshold": row[2], "recharge": row[3], "card": row[4]}
            for row in self.db.execute("SELECT id, auto_recharge, threshold_cents, recharge_cents, card FROM accounts")
        }
        self.ids = sorted(self.accounts)
        self.stopping = False

    def book(self, account, kind, amount, ref):
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.db.execute("INSERT INTO ledger (ts, account_id, kind, amount_cents, ref) VALUES (?, ?, ?, ?, ?)",
                        (ts, account, kind, amount, ref))

    def charge(self, acct):
        body = json.dumps({"account_id": acct["id"], "card": acct["card"], "amount_cents": acct["recharge"]}).encode()
        req = urllib.request.Request(self.cardproc + "/charges", data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.load(resp)["id"]

    def handle(self, account, kind, ref, cost):
        acct = self.accounts[account]
        key = "balance:%d" % account
        try:
            raw = self.redis.get(key)
        except redis.RedisError as exc:
            log("ERROR", "balances store unavailable (%s): event %s skipped" % (redis_error(exc), ref))
            return
        balance = int(raw) if raw is not None else 0
        if balance <= 0 and not acct["auto"]:
            log("WARN", "usage rejected account=%d %s %s: no funds (balance=%d)" % (account, kind, ref, balance))
            return

        self.book(account, "usage", -cost, ref)
        try:
            balance = self.redis.decrby(key, cost)
        except redis.RedisError as exc:
            balance -= cost
            log("ERROR", "balance update failed account=%d op=DECRBY %d: %s" % (account, cost, redis_error(exc)))
        log("INFO", "usage account=%d %s %s cost=%d balance=%d" % (account, kind, ref, cost, balance))

        if acct["auto"] and balance < acct["threshold"]:
            log("WARN", "auto-recharge account=%d balance=%d threshold=%d: charging card %s %d"
                % (account, balance, acct["threshold"], acct["card"], acct["recharge"]))
            try:
                charge_id = self.charge(acct)
            except Exception as exc:
                log("ERROR", "card processor did not take the charge for account=%d: %s" % (account, exc))
                return
            log("INFO", "charge %s approved account=%d amount=%d" % (charge_id, account, acct["recharge"]))
            self.book(account, "recharge", acct["recharge"], charge_id)
            try:
                balance = self.redis.incrby(key, acct["recharge"])
                log("INFO", "charge %s credited account=%d balance=%d" % (charge_id, account, balance))
            except redis.RedisError as exc:
                log("ERROR", "charge %s not credited account=%d op=INCRBY %d: %s"
                    % (charge_id, account, acct["recharge"], redis_error(exc)))

    def run(self):
        log("INFO", "billing-worker started: %d accounts, %d with auto-recharge, one usage event every %.1f s"
            % (len(self.ids), sum(1 for a in self.accounts.values() if a["auto"]), self.tick))
        # a stop request is honoured between two events: an event that has started is always finished and logged
        while not self.stopping:
            account = random.choice(self.ids)
            if random.random() < 0.7:
                kind, ref, cost = "sms", "SM%09x" % random.getrandbits(36), random.randint(1, 2)
            else:
                kind, ref, cost = "call", "CA%09x" % random.getrandbits(36), random.randint(2, 3)
            try:
                self.handle(account, kind, ref, cost)
            except sqlite3.Error as exc:
                log("ERROR", "ledger write failed for account=%d: %s" % (account, exc))
            deadline = time.monotonic() + self.tick
            while not self.stopping and time.monotonic() < deadline:
                time.sleep(0.05)
        log("INFO", "billing-worker stopped")


def main():
    conf = configparser.ConfigParser()
    conf.read(CONF)
    worker = Worker(conf)
    signal.signal(signal.SIGTERM, lambda *_: setattr(worker, "stopping", True))
    worker.run()


if __name__ == "__main__":
    main()
