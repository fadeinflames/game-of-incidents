#!/usr/bin/env python3
"""Job runner of the report pipeline.

Takes jobs from the list jobs:pending in queue-redis and executes them. A runner has several job slots, every slot
holds its own connection (a slot waits for a job with BLPOP, so connections are not shared). The connections form one
pool: when any of them fails, the client closes all of them and opens the whole pool again.

Settings: /etc/runner/runner.conf, read at start and on SIGHUP.
"""
import asyncio
import os
import random
import signal
import sys
import time

CONF = "/etc/runner/runner.conf"
NAME = os.environ.get("RUNNER_NAME", "runner-0")
JOB_SEC = (0.6, 1.4)        # a job is a report build: about a second of work
REPLY_TIMEOUT = 6.0         # BLPOP waits 2 s on the server; a reply later than this means a dead connection
SUMMARY_SEC = 10
BREATHER = 0.05             # between two attempts the event loop always gets 50 ms, so that a refused connection does not spin a CPU core

# name: (default, lowest, highest, type)
SETTINGS = {
    "queue_host": ("127.0.20.11", None, None, str),
    "queue_port": (6380, 1, 65535, int),
    "slots": (8, 1, 64, int),
    "dial_timeout_ms": (1000, 50, 60000, int),
    "redial_pause_ms": (0, 0, 600000, int),
    "redial_backoff": (1.0, 1.0, 10.0, float),
    "redial_pause_max_ms": (30000, 0, 600000, int),
    "redial_jitter": (0.0, 0.0, 1.0, float),
    "redial_budget_per_min": (0, 0, 100000, int),
}


def log(msg):
    sys.stdout.write("%s %s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), NAME, msg))
    sys.stdout.flush()


def load_settings():
    values = {k: v[0] for k, v in SETTINGS.items()}
    try:
        with open(CONF, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError as e:
        log("WARN cannot read %s (%s): built-in defaults are used" % (CONF, e.strerror))
        return values
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, raw = (part.strip() for part in line.split("=", 1))
        if key not in SETTINGS:
            log("WARN %s: unknown setting %r is ignored" % (CONF, key))
            continue
        default, low, high, kind = SETTINGS[key]
        try:
            value = kind(raw)
            if low is not None and not low <= value <= high:
                raise ValueError
        except ValueError:
            log("WARN %s: %s = %r is not valid (allowed %s..%s), the default %s is used" % (CONF, key, raw, low, high, default))
            continue
        values[key] = value
    return values


def describe(s):
    return ("queue=%(queue_host)s:%(queue_port)s slots=%(slots)d dial_timeout_ms=%(dial_timeout_ms)d "
            "redial_pause_ms=%(redial_pause_ms)d redial_backoff=%(redial_backoff)g redial_pause_max_ms=%(redial_pause_max_ms)d "
            "redial_jitter=%(redial_jitter)g redial_budget_per_min=%(redial_budget_per_min)d" % s)


def command(*args):
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        a = a if isinstance(a, bytes) else str(a).encode()
        out.append(b"$%d\r\n%s\r\n" % (len(a), a))
    return b"".join(out)


class RedisError(Exception):
    pass


class DialError(Exception):
    def __init__(self, kind, text):
        super().__init__(text)
        self.kind = kind


async def read_reply(reader):
    line = await reader.readline()
    if not line.endswith(b"\r\n"):
        raise ConnectionError("connection closed by the other side")
    kind, rest = line[:1], line[1:-2]
    if kind == b"+":
        return rest.decode()
    if kind == b"-":
        raise RedisError(rest.decode())
    if kind == b":":
        return int(rest)
    if kind == b"$":
        n = int(rest)
        if n < 0:
            return None
        data = await reader.readexactly(n + 2)
        return data[:-2]
    if kind == b"*":
        n = int(rest)
        if n < 0:
            return None
        return [await read_reply(reader) for _ in range(n)]
    raise ConnectionError("unexpected reply from the server")


class Conn:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer

    async def call(self, *args, timeout=REPLY_TIMEOUT):
        self.writer.write(command(*args))
        return await asyncio.wait_for(read_reply(self.reader), timeout)

    def close(self):
        try:
            self.writer.close()
        except Exception:
            pass


class Runner:
    def __init__(self):
        self.s = load_settings()
        self.pool = []
        self.unfinished = []      # jobs taken from the queue whose work was interrupted: they go back to the queue
        self.unreported = 0       # jobs finished while the pool was down: counted when it is up again
        self.work = {}            # slot -> job in progress
        self.done = 0
        self.tokens = 0.0
        self.tokens_at = time.monotonic()
        self.reset_window()
        self.down_since = None
        self.reloaded = False

    def reset_window(self):
        self.window_at = time.monotonic()
        self.dialed = 0
        self.established = 0
        self.failed = {}

    # ---- opening the pool -------------------------------------------------------------------------------------
    async def dial(self, slot):
        timeout = self.s["dial_timeout_ms"] / 1000.0
        t0 = time.monotonic()
        self.dialed += 1
        writer = None
        try:
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(self.s["queue_host"], self.s["queue_port"]), timeout)
            except asyncio.TimeoutError:
                raise DialError("connect timeout", "slot %d: TCP connect to %s:%d did not finish in %d ms"
                                % (slot, self.s["queue_host"], self.s["queue_port"], self.s["dial_timeout_ms"]))
            except OSError as e:
                raise DialError("connect error", "slot %d: TCP connect to %s:%d failed: %s"
                                % (slot, self.s["queue_host"], self.s["queue_port"], os.strerror(e.errno) if e.errno else e))
            left = max(0.001, timeout - (time.monotonic() - t0))
            try:
                writer.write(command("CLIENT", "SETNAME", "%s/%d" % (NAME, slot)))
                reply = await asyncio.wait_for(read_reply(reader), left)
            except asyncio.TimeoutError:
                raise DialError("no reply", "slot %d: connected to %s:%d, but no reply from Redis in %d ms"
                                % (slot, self.s["queue_host"], self.s["queue_port"], self.s["dial_timeout_ms"]))
            except (OSError, ConnectionError, RedisError, asyncio.IncompleteReadError) as e:
                raise DialError("closed", "slot %d: connection to %s:%d was closed before Redis replied (%s)"
                                % (slot, self.s["queue_host"], self.s["queue_port"], e))
            if reply != "OK":
                raise DialError("closed", "slot %d: unexpected reply to the handshake" % slot)
            self.established += 1
            return Conn(reader, writer)
        except BaseException as e:
            if writer is not None:
                writer.close()
            if isinstance(e, DialError):
                self.failed[e.kind] = self.failed.get(e.kind, 0) + 1
            elif isinstance(e, asyncio.CancelledError):
                self.failed["dropped with the pool"] = self.failed.get("dropped with the pool", 0) + 1
            raise

    async def open_pool(self):
        """All slots or nothing: one failed connection means the whole pool is dialed again."""
        tasks = [asyncio.ensure_future(self.dial(i)) for i in range(self.s["slots"])]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        finally:
            for t in tasks:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        errors = [t.exception() for t in tasks if not t.cancelled() and t.exception() is not None]
        conns = [t.result() for t in tasks if not t.cancelled() and t.exception() is None]
        if errors or len(conns) < len(tasks):
            for c in conns:
                c.close()
            self.established -= len(conns)
            self.failed["dropped with the pool"] = self.failed.get("dropped with the pool", 0) + len(conns)
            raise errors[0] if errors else DialError("closed", "the pool was not opened")
        return conns

    def pause_after(self, failures):
        pause = self.s["redial_pause_ms"] / 1000.0
        if pause > 0 and self.s["redial_backoff"] > 1:
            pause *= self.s["redial_backoff"] ** min(failures - 1, 40)
        if self.s["redial_pause_max_ms"] > 0:
            pause = min(pause, self.s["redial_pause_max_ms"] / 1000.0)
        if pause > 0 and self.s["redial_jitter"] > 0:
            pause *= 1.0 - self.s["redial_jitter"] * random.random()
        return pause

    async def spend_budget(self):
        """Attempts per minute: a bucket that holds one full pool and refills at the configured rate."""
        per_min = self.s["redial_budget_per_min"]
        if per_min <= 0:
            return
        need = self.s["slots"]
        now = time.monotonic()
        self.tokens = min(float(need), self.tokens + (now - self.tokens_at) * per_min / 60.0)
        self.tokens_at = now
        if self.tokens < need:
            wait = (need - self.tokens) * 60.0 / per_min
            await asyncio.sleep(wait)
            self.tokens_at = time.monotonic()
            self.tokens = float(need)
        self.tokens -= need

    def summary(self, force=False):
        now = time.monotonic()
        if not force and now - self.window_at < SUMMARY_SEC:
            return
        if self.dialed:
            reasons = ", ".join("%s: %d" % kv for kv in sorted(self.failed.items())) or "none"
            down = "" if self.down_since is None else "pool is down for %d s; " % (now - self.down_since)
            log("WARN %slast %d s: %d connection attempts, %d established, %d failed (%s)"
                % (down, round(now - self.window_at), self.dialed, self.established, self.dialed - self.established, reasons))
        self.reset_window()

    # ---- working ----------------------------------------------------------------------------------------------
    async def slot(self, i, conn):
        while True:
            reply = await conn.call("BLPOP", "jobs:pending", "2")
            if reply is None:
                continue
            job = reply[1]
            self.work[i] = job
            await asyncio.sleep(random.uniform(*JOB_SEC))
            del self.work[i]
            try:
                await conn.call("INCR", "jobs:done")
            except BaseException:
                self.unreported += 1
                raise
            self.done += 1

    async def settle(self, conn):
        """Give back what the previous pool left behind."""
        if self.unfinished:
            jobs, self.unfinished = self.unfinished, []
            try:
                await conn.call("LPUSH", "jobs:pending", *jobs)
            except BaseException:
                self.unfinished = jobs + self.unfinished
                raise
        if self.unreported:
            n, self.unreported = self.unreported, 0
            try:
                await conn.call("INCRBY", "jobs:done", n)
            except BaseException:
                self.unreported += n
                raise
            self.done += n

    def drop_pool(self):
        for c in self.pool:
            c.close()
        self.pool = []
        self.unfinished.extend(self.work.values())
        self.work = {}

    async def run(self):
        log("started, pid %d; settings: %s" % (os.getpid(), describe(self.s)))
        self.tokens = float(self.s["slots"])
        try:
            await self.serve()
        except asyncio.CancelledError:
            pass
        await self.finish()
        log("stopped")

    async def serve(self):
        failures = 0
        seen = set()
        while True:
            # 1. the pool
            await self.spend_budget()
            started = time.monotonic()
            try:
                self.pool = await self.open_pool()
                await self.settle(self.pool[0])
            except (DialError, OSError, ConnectionError, RedisError, asyncio.TimeoutError, asyncio.IncompleteReadError) as e:
                self.drop_pool()
                if self.reloaded:
                    # new settings: the count of failed attempts in a row starts again
                    self.reloaded = False
                    failures = 0
                failures += 1
                if self.down_since is None:
                    self.down_since = started
                pause = self.pause_after(failures)
                kind = getattr(e, "kind", type(e).__name__)
                if kind not in seen:
                    # every kind of failure is written out once per outage, the rest goes into the summaries
                    seen.add(kind)
                    log("ERROR cannot open the pool: %s; all %d connections are dropped, next attempt %s"
                        % (e, self.s["slots"], "at once" if pause <= 0 else "in %.1f s" % pause))
                self.summary()
                await asyncio.sleep(max(pause, BREATHER))
                continue
            if self.down_since is not None:
                self.summary(force=True)
                log("pool is open again: %d connections to %s:%d after %d failed attempts, %.1f s without the queue"
                    % (len(self.pool), self.s["queue_host"], self.s["queue_port"], failures, time.monotonic() - self.down_since))
            else:
                log("pool is open: %d connections to %s:%d" % (len(self.pool), self.s["queue_host"], self.s["queue_port"]))
                self.reset_window()
            failures = 0
            seen = set()
            self.down_since = None
            # 2. the work, until any connection fails
            tasks = [asyncio.ensure_future(self.slot(i, c)) for i, c in enumerate(self.pool)]
            ticker = asyncio.ensure_future(self.report())
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                ticker.cancel()
                for t in tasks:
                    if not t.done():
                        t.cancel()
                results = await asyncio.gather(*tasks, return_exceptions=True)
            reason = next((r for r in results if isinstance(r, BaseException) and not isinstance(r, asyncio.CancelledError)), None)
            slot = next((i for i, r in enumerate(results) if r is reason), -1)
            self.down_since = time.monotonic()
            self.drop_pool()
            self.reset_window()
            log("ERROR slot %d lost its connection (%s); closing all %d connections of the pool and opening it again"
                % (slot, str(reason) or type(reason).__name__, self.s["slots"]))

    async def finish(self):
        """Graceful stop: jobs that were in progress go back to the queue over a fresh connection."""
        self.drop_pool()
        if self.unfinished or self.unreported:
            try:
                conn = await self.dial(0)
                try:
                    await self.settle(conn)
                finally:
                    conn.close()
            except Exception:
                log("WARN could not return %d unfinished jobs to the queue" % len(self.unfinished))

    async def report(self):
        last = self.done
        while True:
            await asyncio.sleep(60)
            log("pool is open: %d connections, %d jobs done in the last minute" % (len(self.pool), self.done - last))
            last = self.done

    def reload(self):
        old = self.s
        self.s = load_settings()
        self.reloaded = True
        log("settings re-read: %s" % describe(self.s))
        if old["slots"] != self.s["slots"] or (old["queue_host"], old["queue_port"]) != (self.s["queue_host"], self.s["queue_port"]):
            log("WARN slots and the queue address apply to connections opened from now on; restart the runner to apply them at once")


async def main():
    runner = Runner()
    loop = asyncio.get_running_loop()
    task = asyncio.ensure_future(runner.run())
    loop.add_signal_handler(signal.SIGHUP, runner.reload)
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    loop.add_signal_handler(signal.SIGINT, task.cancel)
    await task


if __name__ == "__main__":
    asyncio.run(main())
