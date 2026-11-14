#!/usr/bin/env python3
"""usage-meter: stands in for the gateway nodes of the product on this host.

Every tick one customer sends a request to the paid feature. The meter asks access-api, and when the customer is
allowed it queues a usage record for budget-worker (queue:budget-updates). Gateway nodes also deliver records they
had buffered: those are read from the buffer file and queued as they are, a few per minute. Every record gets the next
number of the shared counter meter:seq.
"""
import configparser
import json
import os
import random
import signal
import time
import urllib.request

import redis

CONF = "/etc/usage-meter/meter.conf"


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(level, msg):
    print("%s %s %s" % (stamp(), level, msg), flush=True)


class Meter:
    def __init__(self, conf):
        self.api = conf.get("api", "url", fallback="http://127.0.0.1:8080").rstrip("/")
        self.queue = conf.get("redis", "queue", fallback="queue:budget-updates")
        self.redis = redis.Redis(host=conf.get("redis", "host", fallback="127.0.0.1"),
                                 port=conf.getint("redis", "port", fallback=6379),
                                 socket_timeout=3, socket_connect_timeout=3, decode_responses=True)
        self.tick = conf.getfloat("meter", "tick_sec", fallback=1.05)
        self.late_every = conf.getint("meter", "buffered_every_ticks", fallback=8)
        first, last = conf.get("meter", "customers", fallback="1001-1060").split("-")
        self.customers = list(range(int(first), int(last) + 1))
        self.buffer_path = conf.get("meter", "buffer", fallback="/var/lib/usage-meter/buffered.jsonl")
        self.offset_path = self.buffer_path + ".offset"
        self.buffered = []
        try:
            with open(self.buffer_path, encoding="utf-8") as fh:
                self.buffered = [line for line in fh.read().splitlines() if line.strip()]
        except OSError:
            pass
        try:
            self.offset = int(open(self.offset_path).read().strip())
        except (OSError, ValueError):
            self.offset = 0
        self.stopping = False
        self.counts = {"checks": 0, "allowed": 0, "refused": 0, "usage": 0, "buffered": 0, "errors": 0}

    def allowed(self, customer):
        with urllib.request.urlopen("%s/v1/access/%d" % (self.api, customer), timeout=3) as resp:
            return bool(json.load(resp).get("allowed"))

    def push(self, record):
        record["seq"] = int(self.redis.incr("meter:seq"))
        record["queued_at"] = stamp()
        self.redis.rpush(self.queue, json.dumps(record))

    def live(self):
        customer = random.choice(self.customers)
        self.counts["checks"] += 1
        if not self.allowed(customer):
            self.counts["refused"] += 1
            return
        self.counts["allowed"] += 1
        amount = random.randint(30, 120) if random.random() < 0.03 else random.randint(1, 6)
        self.push({"type": "usage", "customer": customer, "amount_cents": amount, "at": stamp(),
                   "node": "gw-%d" % random.randint(1, 4)})
        self.counts["usage"] += 1

    def deliver_buffered(self):
        if self.offset >= len(self.buffered):
            return
        record = json.loads(self.buffered[self.offset])
        self.push(record)
        self.offset += 1
        self.counts["buffered"] += 1
        tmp = self.offset_path + ".tmp"
        with open(tmp, "w") as fh:
            fh.write("%d\n" % self.offset)
        os.replace(tmp, self.offset_path)

    def run(self):
        log("INFO", "usage-meter started: %d customers, one request every %.2f s, %d buffered records to deliver"
            % (len(self.customers), self.tick, max(0, len(self.buffered) - self.offset)))
        ticks = 0
        report_at = time.monotonic() + 60
        while not self.stopping:
            ticks += 1
            try:
                self.live()
                if ticks % self.late_every == 0:
                    self.deliver_buffered()
            except Exception as exc:
                self.counts["errors"] += 1
                if self.counts["errors"] <= 3:
                    log("WARN", "request not metered: %s" % exc)
            if time.monotonic() >= report_at:
                report_at = time.monotonic() + 60
                c = self.counts
                log("INFO", "last minute: %d access checks, %d allowed, %d refused; queued %d usage records and %d buffered records%s"
                    % (c["checks"], c["allowed"], c["refused"], c["usage"], c["buffered"],
                       "; %d errors" % c["errors"] if c["errors"] else ""))
                self.counts = dict.fromkeys(c, 0)
            deadline = time.monotonic() + self.tick
            while not self.stopping and time.monotonic() < deadline:
                time.sleep(0.05)
        log("INFO", "usage-meter stopped")


def main():
    conf = configparser.ConfigParser()
    conf.read(CONF)
    meter = Meter(conf)
    signal.signal(signal.SIGTERM, lambda *_: setattr(meter, "stopping", True))
    meter.run()


if __name__ == "__main__":
    main()
