#!/usr/bin/env python3
"""Scheduler of the report pipeline: puts report jobs into the list jobs:pending of queue-redis.

It runs in the data segment next to the queue, so it talks to queue-redis directly and not through the gateway.
"""
import random
import socket
import sys
import time

QUEUE = ("127.0.30.11", 6379)
JOBS_PER_SEC = 40
TICK = 0.25


def log(msg):
    sys.stdout.write("%s scheduler %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    sys.stdout.flush()


def command(*args):
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        a = a if isinstance(a, bytes) else str(a).encode()
        out.append(b"$%d\r\n%s\r\n" % (len(a), a))
    return b"".join(out)


class Redis:
    def __init__(self, addr, name, timeout=3.0):
        self.sock = socket.create_connection(addr, timeout=timeout)
        self.file = self.sock.makefile("rb")
        self.call("CLIENT", "SETNAME", name)

    def call(self, *args):
        self.sock.sendall(command(*args))
        return self.reply()

    def reply(self):
        line = self.file.readline()
        if not line.endswith(b"\r\n"):
            raise ConnectionError("connection closed by the server")
        kind, rest = line[:1], line[1:-2]
        if kind == b"+":
            return rest.decode()
        if kind == b"-":
            raise RuntimeError(rest.decode())
        if kind == b":":
            return int(rest)
        if kind == b"$":
            n = int(rest)
            return None if n < 0 else self.file.read(n + 2)[:-2]
        if kind == b"*":
            n = int(rest)
            return None if n < 0 else [self.reply() for _ in range(n)]
        raise ConnectionError("unexpected reply")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def main():
    log("started: about %d jobs per second into jobs:pending at %s:%d" % (JOBS_PER_SEC, QUEUE[0], QUEUE[1]))
    conn = None
    total = None
    seq = 0
    carry = 0.0
    pause = 1.0
    reported = time.monotonic()
    while True:
        try:
            if conn is None:
                conn = Redis(QUEUE, "scheduler")
                stored = int(conn.call("GET", "jobs:enqueued") or 0)
                total = stored if total is None else max(total, stored)
                pause = 1.0
                log("connected to the queue, %d jobs enqueued so far" % total)
            carry += JOBS_PER_SEC * TICK * random.uniform(0.7, 1.3)
            n = int(carry)
            carry -= n
            if n:
                stamp = int(time.time() * 1000)
                jobs = ["report-%d-%d" % (stamp, seq + i) for i in range(n)]
                seq += n
                conn.call("RPUSH", "jobs:pending", *jobs)
                total += n
                conn.call("SET", "jobs:enqueued", total)
            if time.monotonic() - reported >= 60:
                reported = time.monotonic()
                log("queue: %d jobs enqueued in total, %s waiting" % (total, conn.call("LLEN", "jobs:pending")))
            time.sleep(TICK)
        except (OSError, ConnectionError, RuntimeError) as e:
            if conn is not None:
                conn.close()
                conn = None
            log("ERROR queue-redis at %s:%d: %s; next attempt in %.1f s" % (QUEUE[0], QUEUE[1], e, pause))
            time.sleep(pause * random.uniform(0.5, 1.0))
            pause = min(pause * 2, 8.0)


if __name__ == "__main__":
    main()
