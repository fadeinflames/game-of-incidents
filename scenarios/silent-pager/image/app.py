#!/usr/bin/env python3
"""One image, several small services. The role is picked by the ROLE variable.

  aggregator   builds the product page: one HTTP call to every downstream service per request
  shoppers     load simulator: customers who open the product page and retry when it fails
  backend      stand-in for the downstream services (answers by the Host header) and for `sessions`
  resolver     the datacenter resolver the cluster DNS forwards to (config: /etc/resolver/resolver.conf)
  alert-relay  evaluates the store's success rate and delivers alerts to the paging provider
  pager        stand-in for the external paging provider

Everything listens on plain HTTP; `GET /stats` shows what the service has seen in the last 60 seconds.
"""
import asyncio
import json
import os
import random
import signal
import socket
import struct
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlsplit

ROLE = os.environ.get("ROLE", "backend")
WINDOW = 60.0
REASONS = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error",
           502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"}


def env_f(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


def log(level, msg):
    sys.stdout.write(f"{time.strftime('%H:%M:%S')} {level:<5} {msg}\n")
    sys.stdout.flush()


class Window:
    """events of the last WINDOW seconds: (time, key, value)"""

    def __init__(self):
        self.q = deque()

    def add(self, key, value=1.0):
        now = time.monotonic()
        self.q.append((now, key, value))
        self.trim(now)

    def trim(self, now=None):
        now = now or time.monotonic()
        while self.q and now - self.q[0][0] > WINDOW:
            self.q.popleft()

    def count(self, key=None, prefix=None, since=WINDOW):
        now = time.monotonic()
        self.trim(now)
        return sum(1 for t, k, _ in self.q if now - t <= since and (key is None or k == key) and (prefix is None or k.startswith(prefix)))

    def values(self, key, since=WINDOW):
        now = time.monotonic()
        self.trim(now)
        return sorted(v for t, k, v in self.q if k == key and now - t <= since)


def pct(values, p):
    if not values:
        return None
    return round(values[min(len(values) - 1, int(len(values) * p))], 1)


# ---------------------------------------------------------------- tiny HTTP

async def http_request(ip, port, host, path, method="GET", body=None):
    reader, writer = await asyncio.open_connection(ip, port)
    try:
        head = f"{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n"
        if body is not None:
            head += f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
        writer.write(head.encode() + b"\r\n" + (body or b""))
        await writer.drain()
        data = await reader.read(-1)
    finally:
        writer.close()
    head, _, payload = data.partition(b"\r\n\r\n")
    parts = head.split(b" ", 2)
    if len(parts) < 2 or not parts[1].isdigit():
        raise ConnectionError("no HTTP response")
    return int(parts[1]), payload


async def serve_http(port, handler):
    async def conn(reader, writer):
        status, ctype, out = 500, "text/plain", b"error\n"
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = head.decode("latin1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
            body = b""
            n = int(headers.get("content-length") or 0)
            if n:
                body = await asyncio.wait_for(reader.readexactly(min(n, 65536)), 10)
            peer = (writer.get_extra_info("peername") or ("?", 0))[0]
            url = urlsplit(target)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            status, ctype, out = await handler(method, url.path, query, headers, body, peer)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError):
            pass
        except Exception as e:  # noqa: BLE001
            log("ERROR", f"handler failed: {e!r}")
        try:
            writer.write(f"HTTP/1.1 {status} {REASONS.get(status, 'Status')}\r\nContent-Type: {ctype}\r\n"
                         f"Content-Length: {len(out)}\r\nConnection: close\r\n\r\n".encode() + out)
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()

    return await asyncio.start_server(conn, "0.0.0.0", port, backlog=2048)


def js(obj, status=200):
    return status, "application/json", (json.dumps(obj, indent=1) + "\n").encode()


# ---------------------------------------------------------------- backend (downstream services, sessions)

async def run_backend():
    slow = {}                    # service -> extra delay, seconds
    seen = deque(maxlen=4000)    # (probe id, service): lets a caller verify that a page really reached every service
    win = Window()
    fixed = os.environ.get("SERVICE_NAME", "")

    async def handler(method, path, query, headers, body, peer):
        if path == "/healthz":
            return 200, "text/plain", b"ok\n"
        if path.startswith("/admin/"):
            if peer not in ("127.0.0.1", "::1"):
                return js({"error": "admin endpoints are local only"}, 403)
            if path == "/admin/slow":
                svc, ms = query.get("svc", ""), float(query.get("ms", "0"))
                if ms > 0:
                    slow[svc] = ms / 1000
                    log("WARN", f"{svc}: responses are slow now, about {int(ms)} ms each")
                else:
                    slow.pop(svc, None)
                    log("INFO", f"{svc}: response time is back to normal")
                return js({"slow": {k: int(v * 1000) for k, v in slow.items()}})
            if path == "/admin/seen":
                probe = query.get("probe", "")
                return js({"probe": probe, "services": sorted({s for p, s in seen if p == probe})})
            return js({"error": "unknown admin endpoint"}, 404)
        service = fixed or headers.get("host", "unknown").split(":")[0].split(".")[0]
        delay = 0.01 + random.random() * 0.02 + slow.get(service, 0)
        await asyncio.sleep(delay)
        win.add(service, delay * 1000)
        if query.get("probe"):
            seen.append((query["probe"], service))
        if path == "/stats":
            return js({"requests_60s": {s: win.count(s) for s in sorted({k for _, k, _ in win.q})}})
        return js({"service": service, "data": f"{service}-block", "ms": int(delay * 1000)})

    await serve_http(8080, handler)
    log("INFO", f"backend started ({fixed or 'serves every downstream name by the Host header'})")
    while True:
        await asyncio.sleep(30)
        names = sorted({k for _, k, _ in win.q})
        if names:
            log("INFO", "served in 60 s: " + ", ".join(f"{s}={win.count(s)} (p95 {pct(win.values(s), 0.95)} ms)" for s in names))


# ---------------------------------------------------------------- resolver (the datacenter forwarder)

def load_resolver_conf(path):
    """dnsmasq-like subset: address=/name/ip, server=/zone/ip, local-ttl=N"""
    addresses, forwards, ttl = {}, {}, 5
    with open(path) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if line.startswith("address=/"):
                _, name, ip = line.split("/", 2)
                addresses[name.lower().rstrip(".")] = ip.strip()
            elif line.startswith("server=/"):
                _, zone, ip = line.split("/", 2)
                forwards[zone.lower().rstrip(".")] = ip.strip()
            elif line.startswith("local-ttl="):
                ttl = int(line.split("=", 1)[1])
    return addresses, forwards, ttl


async def run_resolver():
    addresses, forwards, ttl = load_resolver_conf(os.environ.get("RESOLVER_CONF", "/etc/resolver/resolver.conf"))
    st = {"queries": 0, "answered": 0, "nxdomain": 0, "forwarded": 0}
    per_zone = {z: 0 for z in forwards}

    def parse(data):
        i, labels = 12, []
        while data[i]:
            n = data[i]
            if n & 0xC0:
                raise ValueError("compressed question")
            labels.append(data[i + 1:i + 1 + n].decode("ascii", "replace"))
            i += n + 1
        qtype = struct.unpack("!H", data[i + 1:i + 3])[0]
        return ".".join(labels).lower(), qtype, i + 5

    def reply(data, qend, rcode, answer=b""):
        rd = data[2] & 0x01
        flags = 0x8000 | (rd << 8) | 0x0080 | rcode
        return data[:2] + struct.pack("!HHHHH", flags, 1, 1 if answer else 0, 0, 0) + data[12:qend] + answer

    class Proto(asyncio.DatagramProtocol):
        def connection_made(self, transport):
            self.transport = transport

        def datagram_received(self, data, addr):
            try:
                name, qtype, qend = parse(data)
            except (IndexError, ValueError, struct.error):
                return
            st["queries"] += 1
            for zone in forwards:
                if name == zone or name.endswith("." + zone):
                    # Conditional forwarding to the resolvers of that zone. They have been unreachable from this
                    # network segment since the old datacenter was closed: the query is sent and nothing ever
                    # comes back, so this resolver has nothing to relay to its client.
                    st["forwarded"] += 1
                    per_zone[zone] += 1
                    return
            if name in addresses:
                st["answered"] += 1
                if qtype == 1:
                    rr = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, ttl, 4) + socket.inet_aton(addresses[name])
                    self.transport.sendto(reply(data, qend, 0, rr), addr)
                else:
                    self.transport.sendto(reply(data, qend, 0), addr)
                return
            if name == "":
                st["answered"] += 1
                self.transport.sendto(reply(data, qend, 0), addr)
                return
            st["nxdomain"] += 1
            self.transport.sendto(reply(data, qend, 3), addr)

    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(Proto, local_addr=("0.0.0.0", int(env_f("DNS_PORT", "5353"))))

    async def handler(method, path, query, headers, body, peer):
        if path == "/healthz":
            return 200, "text/plain", b"ok\n"
        return js({"totals": st, "forwarded_without_reply": per_zone})

    await serve_http(8080, handler)
    log("INFO", f"resolver started: {len(addresses)} local names, conditional forwarding for: "
                + ", ".join(f"{z} -> {ip}" for z, ip in forwards.items()))
    last = dict(st)
    while True:
        await asyncio.sleep(10)
        d = {k: st[k] - last[k] for k in st}
        last = dict(st)
        if d["queries"]:
            line = f"10 s: {d['queries']} queries, {d['answered']} answered, {d['nxdomain']} NXDOMAIN"
            if d["forwarded"]:
                line += f", {d['forwarded']} forwarded to " + ", ".join(f"{ip} ({z})" for z, ip in forwards.items()) + ": no reply"
            log("INFO", line)


# ---------------------------------------------------------------- aggregator

class Breaker:
    """Per-downstream circuit breaker: opens after THRESHOLD consecutive failures, lets traffic through again after
    OPEN_SEC and opens at once if the first calls fail."""
    THRESHOLD = 5
    OPEN_SEC = 5.0

    def __init__(self, name):
        self.name, self.state, self.fails, self.opened_at, self.last_error = name, "closed", 0, 0.0, ""

    def allow(self):
        if self.state == "open" and time.monotonic() - self.opened_at >= self.OPEN_SEC:
            self.state = "half-open"
        return self.state != "open"

    def ok(self):
        if self.state != "closed":
            log("INFO", f"circuit breaker CLOSED: {self.name}")
        self.state, self.fails = "closed", 0

    def fail(self, error):
        self.fails += 1
        self.last_error = error
        if self.state == "half-open" or (self.state == "closed" and self.fails >= self.THRESHOLD):
            if self.state == "closed":
                log("WARN", f"circuit breaker OPEN: {self.name} ({self.fails} consecutive failures, last: {error})")
            self.state, self.opened_at = "open", time.monotonic()


def load_downstreams(path):
    out = []
    with open(path) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if "=" not in line:
                continue
            name, url = (x.strip() for x in line.split("=", 1))
            u = urlsplit(url)
            out.append({"name": name, "url": url, "host": u.hostname or "", "port": u.port or 80, "path": u.path or "/"})
    return out


async def run_aggregator():
    downstreams = load_downstreams(os.environ.get("DOWNSTREAMS_CONF", "/etc/aggregator/downstreams.conf"))
    call_timeout = env_f("CALL_TIMEOUT_MS", "5000") / 1000
    cache_ttl = env_f("DNS_CACHE_TTL_SEC", "0")
    threading.stack_size(256 * 1024)
    pool = ThreadPoolExecutor(max_workers=int(env_f("RESOLVER_THREADS", "400")), thread_name_prefix="dns")
    loop = asyncio.get_running_loop()
    breakers = {d["name"]: Breaker(d["name"]) for d in downstreams}
    win = Window()
    cache, inflight = {}, {}
    samples = {"t": 0.0, "n": 0}

    def lookup(host, port):
        # the system resolver, exactly as it is configured in /etc/resolv.conf of this pod; nothing is cached here
        infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        for family, _, _, _, sockaddr in infos:
            if family == socket.AF_INET:
                return sockaddr[0]
        return infos[0][4][0]

    async def resolve(host, port):
        fut = None
        if cache_ttl > 0:
            hit = cache.get(host)
            if hit and hit[1] > time.monotonic():
                return hit[0]
            fut = inflight.get(host)          # one lookup per name at a time, the rest wait for its result
        if fut is None:
            t0 = time.monotonic()
            fut = loop.run_in_executor(pool, lookup, host, port)

            def done(f):
                if inflight.get(host) is f:
                    del inflight[host]
                ms = (time.monotonic() - t0) * 1000
                if f.cancelled():
                    return
                if f.exception() is not None:
                    win.add("dns_failed", ms)
                    return
                win.add("dns_ok", ms)
                if cache_ttl > 0:
                    cache[host] = (f.result(), time.monotonic() + cache_ttl)

            fut.add_done_callback(done)
            if cache_ttl > 0:
                inflight[host] = fut
        # the lookup runs in a thread and cannot be interrupted: a caller that gives up just stops waiting for it
        return await asyncio.shield(fut)

    async def call(d, probe):
        # a new connection for every call: the name is resolved again each time
        ip = await resolve(d["host"], d["port"])
        path = d["path"] + (f"?probe={probe}" if probe else "")
        status, payload = await http_request(ip, d["port"], d["host"], path)
        if status >= 500:
            raise ConnectionError(f"HTTP {status}")
        return json.loads(payload or b"{}")

    def sample(name, error):
        now = time.monotonic()
        if now - samples["t"] > 10:
            samples["t"], samples["n"] = now, 0
        if samples["n"] < 6:
            samples["n"] += 1
            log("ERROR", f"call to {name} failed: {error}")

    async def one(d, probe):
        b = breakers[d["name"]]
        if not b.allow():
            win.add(f"err:{d['name']}:circuit_open")
            return d["name"], None, "circuit breaker is open"
        t0 = time.monotonic()
        try:
            data = await asyncio.wait_for(call(d, probe), call_timeout)
        except asyncio.TimeoutError:
            kind, error = "timeout", f"no response in {int(call_timeout * 1000)} ms"
        except socket.gaierror as e:
            kind, error = "dns_error", f"cannot resolve {d['host']}: {e.strerror or e} ({int((time.monotonic() - t0) * 1000)} ms)"
        except (OSError, ValueError) as e:
            kind, error = "connect_error", f"{type(e).__name__}: {e}"
        else:
            b.ok()
            win.add(f"ok:{d['name']}", (time.monotonic() - t0) * 1000)
            return d["name"], data, None
        b.fail(error)
        win.add(f"err:{d['name']}:{kind}")
        sample(d["name"], error)
        return d["name"], None, error

    async def handler(method, path, query, headers, body, peer):
        if path == "/healthz":
            return 200, "text/plain", b"ok\n"
        if path == "/stats":
            names = [d["name"] for d in downstreams]
            return js({
                "role": "aggregator",
                "settings": {"call_timeout_ms": int(call_timeout * 1000), "dns_cache_ttl_sec": cache_ttl,
                             "connections": "a new connection for every call"},
                "pages_60s": {"ok": win.count("page_ok"), "failed": win.count("page_failed"),
                              "p50_ms": pct(win.values("page_ok"), 0.5), "p95_ms": pct(win.values("page_ok"), 0.95)},
                "dns_60s": {"lookups_ok": win.count("dns_ok"), "lookups_failed": win.count("dns_failed"),
                            "p50_ms": pct(win.values("dns_ok"), 0.5), "p95_ms": pct(win.values("dns_ok"), 0.95)},
                "downstreams": {n: {"url": next(d["url"] for d in downstreams if d["name"] == n),
                                    "breaker": breakers[n].state, "ok_60s": win.count(f"ok:{n}"),
                                    "errors_60s": {k.split(":", 2)[2]: win.count(k) for k in sorted({k for _, k, _ in win.q if k.startswith(f"err:{n}:")})},
                                    "last_error": breakers[n].last_error} for n in names},
            })
        if path != "/page":
            return js({"error": "not found"}, 404)
        t0 = time.monotonic()
        results = await asyncio.gather(*(one(d, query.get("probe", "")) for d in downstreams))
        failed = {name: err for name, _, err in results if err}
        ms = int((time.monotonic() - t0) * 1000)
        if failed:
            win.add("page_failed", ms)
            return js({"error": "the page cannot be assembled", "failed": failed, "ms": ms}, 502)
        win.add("page_ok", ms)
        return js({"page": "ok", "blocks": {name: data.get("data") for name, data, _ in results}, "ms": ms})

    await serve_http(8080, handler)
    log("INFO", f"aggregator started: {len(downstreams)} downstream services, call timeout {int(call_timeout * 1000)} ms, "
                f"dns cache ttl {cache_ttl:g} s, a new connection for every call")
    while True:
        await asyncio.sleep(10)
        ok, failed = win.count("page_ok", since=10), win.count("page_failed", since=10)
        if not ok and not failed:
            continue
        errs = {}
        now = time.monotonic()
        for t, k, _ in win.q:
            if now - t <= 10 and k.startswith("err:"):
                kind = k.split(":", 2)[2]
                errs[kind] = errs.get(kind, 0) + 1
        open_now = sorted(n for n, b in breakers.items() if b.state != "closed")
        line = f"10 s: pages ok={ok} failed={failed}"
        if errs:
            line += "; failed calls: " + ", ".join(f"{k}={v}" for k, v in sorted(errs.items()))
        if open_now:
            line += f"; open circuit breakers: {len(open_now)} of {len(breakers)} ({', '.join(open_now)})"
        log("WARN" if failed else "INFO", line)


# ---------------------------------------------------------------- shoppers (load simulator)

async def run_shoppers():
    target = urlsplit(os.environ.get("TARGET_URL", "http://10.96.30.10/page"))
    rate = env_f("SHOPPERS_PER_SEC", "1")
    attempt_timeout = env_f("ATTEMPT_TIMEOUT_MS", "7000") / 1000
    retry_after = env_f("RETRY_AFTER_MS", "3000") / 1000
    patience = env_f("PATIENCE_SEC", "60")
    win = Window()
    state = {"retrying": 0, "active": 0, "open": False}

    async def attempt():
        try:
            status, _ = await asyncio.wait_for(http_request(target.hostname, target.port or 80, target.hostname, target.path or "/"), attempt_timeout)
        except asyncio.TimeoutError:
            return "timeout"
        except OSError as e:
            return type(e).__name__
        return str(status)

    async def shopper():
        t0 = time.monotonic()
        state["active"] += 1
        retried = False
        try:
            while True:
                res = await attempt()
                win.add(f"attempt:{res}")
                if res == "200":
                    win.add("shopper_ok", (time.monotonic() - t0) * 1000)
                    return
                if time.monotonic() - t0 + retry_after > patience:
                    win.add("shopper_gave_up")
                    return
                if not retried:
                    retried = True
                    state["retrying"] += 1
                # the page did not open: reload it again and again, at a fixed interval
                await asyncio.sleep(retry_after)
        finally:
            state["active"] -= 1
            if retried:
                state["retrying"] -= 1

    def stats():
        ok, gave_up = win.count("shopper_ok"), win.count("shopper_gave_up")
        attempts = {k.split(":", 1)[1]: win.count(k) for k in sorted({k for _, k, _ in win.q if k.startswith("attempt:")})}
        return {
            "role": "shoppers",
            "settings": {"target": target.geturl(), "shoppers_per_sec": rate, "retry_after_ms": int(retry_after * 1000),
                         "patience_sec": patience},
            "shoppers_60s": {"served": ok, "gave_up": gave_up,
                             "success_rate": round(ok / (ok + gave_up), 3) if ok + gave_up else None,
                             "p50_ms": pct(win.values("shopper_ok"), 0.5), "p95_ms": pct(win.values("shopper_ok"), 0.95)},
            "attempts_60s": attempts,
            "now": {"shoppers_on_the_page": state["active"], "of_them_retrying": state["retrying"],
                    "store_opened": state["open"]},
        }

    async def handler(method, path, query, headers, body, peer):
        if path == "/healthz":
            return 200, "text/plain", b"ok\n"
        return js(stats())

    async def report():
        while True:
            await asyncio.sleep(10)
            attempts = {}
            now = time.monotonic()
            for t, k, _ in win.q:
                if now - t <= 10 and k.startswith("attempt:"):
                    attempts[k.split(":", 1)[1]] = attempts.get(k.split(":", 1)[1], 0) + 1
            bad = sum(v for k, v in attempts.items() if k != "200")
            log("WARN" if bad else "INFO",
                f"10 s: served={win.count('shopper_ok', since=10)} gave_up={win.count('shopper_gave_up', since=10)} "
                f"retrying_now={state['retrying']}; attempts: " + (", ".join(f"{k}={v}" for k, v in sorted(attempts.items())) or "none"))

    await serve_http(9090, handler)
    log("INFO", f"shoppers started: {rate:g} new shoppers per second -> {target.geturl()}, a failed page is reloaded "
                f"every {retry_after:g} s for up to {patience:g} s")
    # the simulator sends shoppers only after the store has opened: one probe every 2 s until the page answers
    while await attempt() != "200":
        await asyncio.sleep(2)
    state["open"] = True
    log("INFO", "the store answers, shoppers are coming")
    asyncio.ensure_future(report())
    tasks = set()
    while True:
        await asyncio.sleep(random.expovariate(rate))
        if len(tasks) < 2000:
            t = asyncio.ensure_future(shopper())
            tasks.add(t)
            t.add_done_callback(tasks.discard)


# ---------------------------------------------------------------- alert-relay and pager

async def run_alert_relay():
    scrape = urlsplit(os.environ.get("SCRAPE_URL", "http://10.96.30.20:9090/stats"))
    deliver = urlsplit(os.environ.get("PAGER_URL", "http://events.pager.example/v1/enqueue"))
    cluster = os.environ.get("CLUSTER_NAME", "store-prod-1")
    threshold = env_f("SUCCESS_RATE_THRESHOLD", "0.9")
    for_sec = env_f("ALERT_FOR_SEC", "120")
    loop = asyncio.get_running_loop()
    queue = deque(maxlen=500)
    st = {"firing_since": None, "bad": 0, "delivered": 0, "failed": 0, "last_error": "", "last_delivery": None, "rate": None,
          "pause": 0, "next_try": 0.0}

    async def post(event):
        # the paging provider is an external service: its name is resolved through the cluster DNS on every delivery
        infos = await loop.getaddrinfo(deliver.hostname, deliver.port or 80, type=socket.SOCK_STREAM)
        ip = next((i[4][0] for i in infos if i[0] == socket.AF_INET), infos[0][4][0])
        status, _ = await http_request(ip, deliver.port or 80, deliver.hostname, deliver.path, "POST", json.dumps(event).encode())
        if status != 200:
            raise ConnectionError(f"HTTP {status}")

    async def flush():
        while queue:
            event = queue[0]
            try:
                await asyncio.wait_for(post(event), 8)
            except asyncio.TimeoutError:
                err = f"no response from {deliver.hostname} in 8 s"
            except socket.gaierror as e:
                err = f"cannot resolve {deliver.hostname}: {e.strerror or e}"
            except OSError as e:
                err = f"{type(e).__name__}: {e}"
            else:
                queue.popleft()
                st["delivered"] += 1
                st["last_delivery"] = time.time()
                continue
            # a failed delivery is retried with a growing pause: 10, 20, 40, then every 60 seconds
            st["failed"] += 1
            st["pause"] = min(60, max(10, st["pause"] * 2))
            st["next_try"] = time.monotonic() + st["pause"]
            log("ERROR", f"delivery to the paging provider failed: {err}; undelivered events: {len(queue)}, "
                         f"next attempt in {st['pause']} s")
            st["last_error"] = err
            return
        st["pause"] = 0
        if st["last_error"]:
            log("INFO", "delivery to the paging provider works again, the queue is empty")
            st["last_error"] = ""

    async def evaluate():
        try:
            status, payload = await asyncio.wait_for(http_request(scrape.hostname, scrape.port or 80, scrape.hostname, scrape.path), 4)
            rate = json.loads(payload)["shoppers_60s"]["success_rate"]
        except (asyncio.TimeoutError, OSError, ValueError, KeyError):
            return
        st["rate"] = rate
        if rate is None:
            return
        if rate < threshold:
            st["bad"] = st["bad"] or time.monotonic()
            if time.monotonic() - st["bad"] >= for_sec and not st["firing_since"]:
                st["firing_since"] = time.time()
                log("WARN", f"alert StoreSuccessRate is FIRING: {rate * 100:.0f} % of shoppers served in the last minute")
                queue.append({"type": "alert", "alert": "StoreSuccessRate", "state": "firing", "cluster": cluster,
                              "since": st["firing_since"], "summary": f"{rate * 100:.0f} % of shoppers served in the last minute"})
        else:
            st["bad"] = 0
            if st["firing_since"]:
                log("INFO", f"alert StoreSuccessRate is resolved: {rate * 100:.0f} % of shoppers served")
                queue.append({"type": "alert", "alert": "StoreSuccessRate", "state": "resolved", "cluster": cluster,
                              "since": st["firing_since"], "summary": f"{rate * 100:.0f} % of shoppers served in the last minute"})
                st["firing_since"] = None

    async def handler(method, path, query, headers, body, peer):
        if path == "/healthz":
            return 200, "text/plain", b"ok\n"
        return js({"role": "alert-relay", "rule": f"StoreSuccessRate < {threshold * 100:.0f} % for {for_sec:g} s",
                   "store_success_rate": st["rate"],
                   "alert_StoreSuccessRate": "firing" if st["firing_since"] else ("pending" if st["bad"] else "ok"),
                   "delivery": {"target": deliver.geturl(), "delivered": st["delivered"], "undelivered_now": len(queue),
                                "last_error": st["last_error"],
                                "next_attempt_in_sec": max(0, int(st["next_try"] - time.monotonic())) if st["last_error"] else 0,
                                "last_delivery_age_sec": int(time.time() - st["last_delivery"]) if st["last_delivery"] else None}})

    await serve_http(9090, handler)
    log("INFO", f"alert-relay started: rule StoreSuccessRate < {threshold * 100:.0f} % for {for_sec:g} s, events go to {deliver.geturl()}")
    tick = 0
    while True:
        await asyncio.sleep(5)
        tick += 1
        await evaluate()
        if tick % 2 == 0:
            # keep one heartbeat at most in the queue, alerts are never dropped
            if not any(e["type"] == "heartbeat" for e in queue):
                queue.append({"type": "heartbeat", "cluster": cluster, "sent": time.time()})
        if time.monotonic() >= st["next_try"]:
            await flush()


async def run_pager():
    events = deque(maxlen=200)
    st = {"last_heartbeat": None, "heartbeats": 0}

    async def handler(method, path, query, headers, body, peer):
        if path == "/healthz":
            return 200, "text/plain", b"ok\n"
        if path == "/v1/enqueue" and method == "POST":
            try:
                event = json.loads(body)
            except ValueError:
                return js({"error": "bad json"}, 400)
            now = time.time()
            if event.get("type") == "heartbeat":
                st["last_heartbeat"], st["heartbeats"] = now, st["heartbeats"] + 1
                if st["heartbeats"] % 6 == 1:
                    log("INFO", f"heartbeat from {event.get('cluster')} (received {st['heartbeats']} so far)")
            else:
                late = int(now - float(event.get("since") or now))
                events.append({"received": time.strftime("%H:%M:%S"), **event, "late_sec": late})
                if event.get("state") == "firing":
                    log("WARN", f"PAGE on-call: {event.get('alert')} firing in {event.get('cluster')}: {event.get('summary')} "
                                f"(the alert started {late} s before this event arrived)")
                else:
                    log("INFO", f"{event.get('alert')} resolved in {event.get('cluster')}")
            return js({"status": "accepted"})
        return js({"role": "pager", "heartbeats_received": st["heartbeats"],
                   "last_heartbeat_age_sec": int(time.time() - st["last_heartbeat"]) if st["last_heartbeat"] else None,
                   "events": list(events)})

    await serve_http(8080, handler)
    log("INFO", "pager started: accepts events on POST /v1/enqueue")
    while True:
        await asyncio.sleep(3600)


ROLES = {"aggregator": run_aggregator, "shoppers": run_shoppers, "backend": run_backend, "resolver": run_resolver,
         "alert-relay": run_alert_relay, "pager": run_pager}

if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    if ROLE not in ROLES:
        log("ERROR", f"unknown ROLE {ROLE!r}")
        sys.exit(2)
    asyncio.run(ROLES[ROLE]())
