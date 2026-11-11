#!/usr/bin/env python3
"""Stand-in for a hosted metrics service. One image, four roles (env ROLE):

ingester  keeps the samples it is given in memory and heartbeats into the ring kept by the gateway
gateway   the front door: sends every write to the ingesters of the ring and needs WRITE_QUORUM acknowledgements
agents    the customers' agents: one batch a second; a failed batch stays in the buffer and is retried without backoff
alerting  watches the gateway's write success ratio and logs the state of the alert
"""
import collections
import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROLE = os.environ.get("ROLE", "ingester")
NAME = os.environ.get("HOSTNAME", "?")


def log(level, msg):
    sys.stdout.write("%s [%s] %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), level, msg))
    sys.stdout.flush()


def http(method, url, data=None, timeout=1.0):
    """-> (status, text); status 0 means there was no HTTP answer at all"""
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001  refused, timeout, DNS
        return 0, str(e)


class Base(BaseHTTPRequestHandler):
    def reply(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        # a proxy in front (the API server's service proxy, for one) may send the body chunked, without Content-Length
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            data = b""
            while len(data) <= 65536:
                try:
                    size = int(self.rfile.readline(1024).split(b";")[0].strip() or b"0", 16)
                except ValueError:
                    return b""
                if size == 0:
                    while self.rfile.readline(1024).strip():
                        pass  # trailers
                    break
                data += self.rfile.read(size)
                self.rfile.readline(1024)
            return data
        n = min(int(self.headers.get("Content-Length") or 0), 65536)
        return self.rfile.read(n) if n > 0 else b""

    def log_message(self, fmt, *args):  # noqa: N802
        pass


def serve(port, handler):
    srv = ThreadingHTTPServer(("0.0.0.0", port), handler)
    srv.daemon_threads = True
    return srv


# ---------------------------------------------------------------------------------------------------------- ingester
def run_ingester():
    port = 9095
    ring_url = os.environ.get("RING_URL", "").rstrip("/")
    addr = "%s:%d" % (os.environ.get("POD_IP", "127.0.0.1"), port)
    tokens = collections.OrderedDict()
    lock = threading.Lock()
    state = {"received": 0}

    class H(Base):
        def do_GET(self):  # noqa: N802
            path, _, query = self.path.partition("?")
            if path == "/ready":
                self.reply(200, "ready\n")
            elif path == "/has":
                token = urllib.parse.parse_qs(query).get("token", [""])[0]
                with lock:
                    found = token in tokens
                self.reply(200, "yes\n" if found else "no\n")
            elif path == "/stats":
                with lock:
                    doc = {"ingester": NAME, "samples_in_memory": state["received"]}
                self.reply(200, json.dumps(doc) + "\n", "application/json")
            else:
                self.reply(404, "not found\n")

        def do_POST(self):  # noqa: N802
            if self.path != "/push":
                self.reply(404, "not found\n")
                return
            try:
                doc = json.loads(self.body() or b"{}")
            except ValueError:
                self.reply(400, "bad json\n")
                return
            token = str(doc.get("token", ""))[:128] if isinstance(doc, dict) else ""
            with lock:
                state["received"] += 1
                if token:
                    tokens[token] = True
                    if len(tokens) > 20000:
                        tokens.popitem(last=False)
            self.reply(200, "ok\n")

    def heartbeat():
        joined = None
        payload = json.dumps({"name": NAME, "addr": addr}).encode()
        while True:
            code, text = http("POST", ring_url + "/ring/heartbeat", payload)
            if code == 200 and joined is not True:
                log("INFO", "ring: joined as %s (%s), state ACTIVE" % (NAME, addr))
                joined = True
            elif code != 200 and joined is not False:
                log("WARN", "ring: heartbeat to the gateway failed (%s), retrying every 2s" % (text.strip()[:120] or code))
                joined = False
            time.sleep(2)

    def leave(*_):
        if ring_url:
            http("POST", ring_url + "/ring/leave", json.dumps({"name": NAME}).encode())
        log("INFO", "shutting down: left the ring, flushed %d samples to long-term storage" % state["received"])
        os._exit(0)

    signal.signal(signal.SIGTERM, leave)
    if ring_url:
        threading.Thread(target=heartbeat, daemon=True).start()
    else:
        log("INFO", "ring: RING_URL is not set, running standalone (the contour is not connected to a gateway yet)")
    log("INFO", "ingester %s listening on :%d" % (NAME, port))
    serve(port, H).serve_forever()


# ----------------------------------------------------------------------------------------------------------- gateway
def run_gateway():
    rf = int(os.environ.get("REPLICATION_FACTOR", "3"))
    quorum = int(os.environ.get("WRITE_QUORUM", "2"))
    heartbeat_timeout = 6.0
    ring = {}  # name -> {"addr": "ip:port", "seen": ts, "healthy": bool}
    lock = threading.Lock()
    window = collections.deque()  # (ts, ok) of the pushes of the last minute
    last = {"error": ""}

    def healthy_members():
        with lock:
            return sorted((n, m["addr"]) for n, m in ring.items() if m["healthy"])[:rf]

    def record(ok):
        now = time.time()
        with lock:
            window.append((now, ok))
            while window and window[0][0] < now - 60:
                window.popleft()

    def counts(seconds):
        now = time.time()
        with lock:
            recent = [ok for ts, ok in window if ts >= now - seconds]
        return len(recent), sum(1 for ok in recent if ok)

    class H(Base):
        def do_GET(self):  # noqa: N802
            path = self.path.partition("?")[0]
            if path == "/healthz":
                self.reply(200, "ok\n")
            elif path == "/ring":
                now = time.time()
                with lock:
                    rows = sorted(ring.items())
                    alive = sum(1 for _, m in rows if m["healthy"])
                    lines = ["replication factor %d, write quorum %d, healthy ingesters: %d" % (rf, quorum, alive), "%-14s %-22s %-10s %s" % ("INGESTER", "ADDRESS", "STATE", "LAST HEARTBEAT")]
                    for n, m in rows:
                        lines.append("%-14s %-22s %-10s %.0fs ago" % (n, m["addr"], "ACTIVE" if m["healthy"] else "UNHEALTHY", now - m["seen"]))
                self.reply(200, "\n".join(lines) + "\n")
            elif path == "/stats":
                total, ok = counts(60)
                doc = {"window_seconds": 60, "push_requests": total, "ok": ok, "failed": total - ok, "requests_per_second": round(total / 60.0, 1), "success_ratio": (round(ok / total, 3) if total else None)}
                self.reply(200, json.dumps(doc) + "\n", "application/json")
            else:
                self.reply(404, "not found\n")

        def do_POST(self):  # noqa: N802
            path = self.path.partition("?")[0]
            raw = self.body()
            if path in ("/ring/heartbeat", "/ring/leave"):
                try:
                    doc = json.loads(raw or b"{}")
                    name = str(doc["name"])[:64]
                except (ValueError, KeyError, TypeError):
                    self.reply(400, "bad request\n")
                    return
                with lock:
                    if path == "/ring/leave":
                        if ring.pop(name, None) is not None:
                            log("WARN", "ring: %s left the ring (shutting down)" % name)
                    else:
                        addr = str(doc.get("addr", ""))[:64]
                        old = ring.get(name)
                        if old is None or not old["healthy"] or old["addr"] != addr:
                            log("INFO", "ring: %s joined (%s), state ACTIVE" % (name, addr))
                        ring[name] = {"addr": addr, "seen": time.time(), "healthy": True}
                self.reply(200, "ok\n")
            elif path == "/api/v1/push":
                members = healthy_members()
                acks = 0
                for _, addr in members:
                    code, _ = http("POST", "http://%s/push" % addr, raw, timeout=0.7)
                    if code == 200:
                        acks += 1
                if acks >= quorum:
                    record(True)
                    self.reply(200, json.dumps({"status": "ok", "replicas": acks}) + "\n", "application/json")
                else:
                    names = ", ".join(n for n, _ in members) or "none"
                    msg = "quorum not reached: written to %d of %d replicas, need %d (healthy ingesters in the ring: %s)" % (acks, rf, quorum, names)
                    last["error"] = msg
                    record(False)
                    self.reply(503, msg + "\n")
            else:
                self.reply(404, "not found\n")

    def reaper():
        while True:
            time.sleep(2)
            now = time.time()
            with lock:
                for n in list(ring):
                    m = ring[n]
                    if m["healthy"] and now - m["seen"] > heartbeat_timeout:
                        m["healthy"] = False
                        log("WARN", "ring: %s missed heartbeats for %.0fs, marked UNHEALTHY" % (n, now - m["seen"]))
                    elif not m["healthy"] and now - m["seen"] > 120:
                        del ring[n]
                        log("WARN", "ring: %s forgotten after 120s without heartbeats" % n)

    def summary():
        while True:
            time.sleep(10)
            total, ok = counts(10)
            if not total:
                continue
            log("INFO", "push: %d requests in the last 10s (%.1f req/s), %d ok, %d failed" % (total, total / 10.0, ok, total - ok))
            if total - ok:
                log("ERROR", "push failed: %s" % last["error"])

    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    threading.Thread(target=reaper, daemon=True).start()
    threading.Thread(target=summary, daemon=True).start()
    log("INFO", "gateway listening on :8080 (replication factor %d, write quorum %d)" % (rf, quorum))
    serve(8080, H).serve_forever()


# ------------------------------------------------------------------------------------------------------------ agents
def run_agents():
    url = os.environ.get("GATEWAY_URL", "http://gateway").rstrip("/") + "/api/v1/push"
    retry_pause = float(os.environ.get("RETRY_PAUSE_SECONDS", "0.1"))  # the same pause after every failure: no backoff
    buffer = collections.deque()
    seq = 0
    sent = ok = failed = dropped = 0
    last_error = ""
    failing = False
    next_batch = time.time()
    next_report = time.time() + 10
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    log("INFO", "agents: remote write to %s, 1 batch per second, failed batches are kept and retried every %.1fs" % (url, retry_pause))
    while True:
        now = time.time()
        while now >= next_batch:
            seq += 1
            next_batch += 1.0
            buffer.append(json.dumps({"series": "customer_samples", "token": "batch-%s-%d" % (NAME, seq), "samples": 500}).encode())
            if len(buffer) > 7200:
                buffer.popleft()
                dropped += 1
        if buffer:
            code, text = http("POST", url, buffer[0], timeout=2.0)
            sent += 1
            if code == 200:
                buffer.popleft()
                ok += 1
                if failing and not buffer:
                    failing = False
                    log("INFO", "remote write recovered: the buffer is replayed, %d batches dropped" % dropped)
                if buffer:
                    time.sleep(retry_pause)
            else:
                failed += 1
                failing = True
                last_error = ("HTTP %d: %s" % (code, text.strip()[:160])) if code else text.strip()[:160]
                time.sleep(retry_pause)
        else:
            time.sleep(max(0.0, min(0.5, next_batch - time.time())))
        if time.time() >= next_report:
            next_report = time.time() + 10
            if failed:
                log("WARN", "remote write: %d requests in the last 10s, %d ok, %d failed (%s); %d batches buffered, retrying without backoff" % (sent, ok, failed, last_error, len(buffer)))
            elif len(buffer) > 1:
                log("INFO", "remote write: %d requests in the last 10s, %d ok, 0 failed; replaying the buffer, %d batches left" % (sent, ok, len(buffer)))
            else:
                log("INFO", "remote write: %d requests in the last 10s, %d ok, 0 failed; buffer empty" % (sent, ok))
            sent = ok = failed = 0


# ---------------------------------------------------------------------------------------------------------- alerting
def run_alerting():
    url = os.environ.get("GATEWAY_URL", "http://gateway").rstrip("/") + "/stats"

    class H(Base):
        def do_GET(self):  # noqa: N802
            self.reply(200, "ok\n")

    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    threading.Thread(target=serve(8080, H).serve_forever, daemon=True).start()
    log("INFO", "alerting: rule MetricsWriteErrors watches %s every 10s" % url)
    firing = False
    bad = good = 0
    reminded = 0.0
    while True:
        time.sleep(10)
        code, text = http("GET", url, timeout=3.0)
        ratio = None
        if code == 200:
            try:
                ratio = json.loads(text).get("success_ratio")
            except ValueError:
                ratio = None
            if ratio is None:
                continue  # no writes in the window: nothing to judge
        healthy = ratio is not None and ratio >= 0.99
        detail = ("write success ratio over the last minute: %.0f %%" % (ratio * 100)) if ratio is not None else "the gateway does not answer"
        if healthy:
            good, bad = good + 1, 0
            if firing and good >= 2:
                firing = False
                log("ALERT", "RESOLVED MetricsWriteErrors: %s" % detail)
        else:
            bad, good = bad + 1, 0
            if not firing and bad >= 2:
                firing = True
                reminded = time.time()
                log("ALERT", "FIRING MetricsWriteErrors: %s; paging the on-call" % detail)
            elif firing and time.time() - reminded >= 60:
                reminded = time.time()
                log("ALERT", "still FIRING MetricsWriteErrors: %s" % detail)


if __name__ == "__main__":
    {"ingester": run_ingester, "gateway": run_gateway, "agents": run_agents, "alerting": run_alerting}.get(ROLE, run_ingester)()
