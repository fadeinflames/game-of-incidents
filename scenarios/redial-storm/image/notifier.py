#!/usr/bin/env python3
"""Notifier: tells users that their report is ready.

Before a notification goes out, the notifier marks it in its store (notify-redis) so that a user never gets the same
message twice. Without the store nothing is sent: notifications wait in memory.

The notifier does not keep a connection open. Every two seconds it connects to the store, sends what has piled up and
disconnects. When the store cannot be reached, the pause before the next attempt grows.

Settings: /etc/notifier/notifier.conf, read at start.
"""
import collections
import random
import socket
import sys
import time

CONF = "/etc/notifier/notifier.conf"
PER_SEC = 4              # new notifications per second
SEND_BATCH = 200         # at most this many notifications in one connection
WAITING_MAX = 50000

SETTINGS = {
    "store_host": ("127.0.20.12", str),
    "store_port": (6380, int),
    "flush_interval_ms": (2000, int),
    "connect_timeout_ms": (1500, int),
    "reconnect_pause_ms": (1000, int),
    "reconnect_backoff": (2.0, float),
    "reconnect_pause_max_ms": (8000, int),
    "reconnect_jitter": (0.5, float),
}


def log(msg):
    sys.stdout.write("%s notifier %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    sys.stdout.flush()


def load_settings():
    values = {k: v[0] for k, v in SETTINGS.items()}
    try:
        with open(CONF, encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if "=" not in line:
                    continue
                key, raw = (part.strip() for part in line.split("=", 1))
                if key in SETTINGS:
                    try:
                        values[key] = SETTINGS[key][1](raw)
                    except ValueError:
                        log("WARN %s: %s = %r is not valid, the default is used" % (CONF, key, raw))
    except OSError as e:
        log("WARN cannot read %s (%s): built-in defaults are used" % (CONF, e.strerror))
    return values


def command(*args):
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        a = a if isinstance(a, bytes) else str(a).encode()
        out.append(b"$%d\r\n%s\r\n" % (len(a), a))
    return b"".join(out)


class Store:
    """One short connection to the store: TCP connect and the first reply must fit into the connect timeout."""

    def __init__(self, host, port, timeout):
        deadline = time.monotonic() + timeout
        self.sock = socket.create_connection((host, port), timeout=timeout)
        try:
            self.file = self.sock.makefile("rb")
            self.sock.settimeout(max(0.05, deadline - time.monotonic()))
            self.call("CLIENT", "SETNAME", "notifier")
            self.sock.settimeout(3.0)
        except BaseException:
            self.close()
            raise

    def call(self, *args):
        self.sock.sendall(command(*args))
        line = self.file.readline()
        if not line.endswith(b"\r\n"):
            raise ConnectionError("connection closed by the other side")
        kind, rest = line[:1], line[1:-2]
        if kind == b"-":
            raise RuntimeError(rest.decode())
        if kind == b":":
            return int(rest)
        if kind == b"$":
            n = int(rest)
            return None if n < 0 else self.file.read(n + 2)[:-2]
        return rest.decode()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def flush(s, waiting):
    """-> how many notifications went out over one connection"""
    store = Store(s["store_host"], s["store_port"], s["connect_timeout_ms"] / 1000.0)
    sent = 0
    try:
        while waiting and sent < SEND_BATCH:
            item = waiting[0]
            # the mark comes first: a notification that is already marked was sent before
            if store.call("SET", "notify:dedup:" + item, "1", "NX", "EX", "600") is not None:
                store.call("INCR", "notify:sent")
            waiting.popleft()
            sent += 1
    finally:
        store.close()
    return sent


def main():
    s = load_settings()
    addr = "%s:%d" % (s["store_host"], s["store_port"])
    log("started; store %s, a connection every %d ms, connect_timeout_ms=%d, after a failure: pause %d ms x%g up to %d ms, jitter %g"
        % (addr, s["flush_interval_ms"], s["connect_timeout_ms"], s["reconnect_pause_ms"], s["reconnect_backoff"],
           s["reconnect_pause_max_ms"], s["reconnect_jitter"]))
    waiting = collections.deque()
    seq = 0
    carry = 0.0
    failures = 0
    next_flush = time.monotonic()
    sent_minute = 0
    reported = time.monotonic()
    while True:
        now = time.monotonic()
        carry += PER_SEC * 0.25
        while carry >= 1:
            carry -= 1
            seq += 1
            if len(waiting) < WAITING_MAX:
                waiting.append("n-%d-%d" % (int(time.time()), seq))
        if waiting and now >= next_flush:
            try:
                sent = flush(s, waiting)
                sent_minute += sent
                if failures:
                    log("store %s is reachable again after %d failed attempts: %d notifications sent, %d still waiting"
                        % (addr, failures, sent, len(waiting)))
                failures = 0
                next_flush = time.monotonic() + (s["flush_interval_ms"] / 1000.0 if len(waiting) < SEND_BATCH else 0.25)
            except (OSError, ConnectionError, RuntimeError) as e:
                failures += 1
                pause = min(s["reconnect_pause_ms"] * s["reconnect_backoff"] ** min(failures - 1, 30), s["reconnect_pause_max_ms"]) / 1000.0
                pause *= 1.0 - s["reconnect_jitter"] * random.random()
                next_flush = time.monotonic() + pause
                reason = "no answer in %d ms" % s["connect_timeout_ms"] if isinstance(e, socket.timeout) else str(e)
                log("ERROR store %s is unreachable (%s); %d notifications are waiting, next attempt in %.1f s"
                    % (addr, reason, len(waiting), pause))
        if now - reported >= 60:
            reported = now
            log("%d notifications sent in the last minute, %d waiting" % (sent_minute, len(waiting)))
            sent_minute = 0
        time.sleep(0.25)


if __name__ == "__main__":
    main()
