#!/usr/bin/env python3
"""order-service: GET /order calls payment-service (by pod IP, from the headless Service) with a 2 s timeout and its own
circuit breaker: an endpoint that fails 3 times in a row is EJECTED for BREAKER_EJECT_SECONDS. GET /breaker shows the
table. Restarting the pod resets the table (like restarting a waypoint proxy)."""
import json
import os
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PEERS = os.environ.get("PAYMENT_PEERS", "payment-service-peers")
EJECT = int(os.environ.get("BREAKER_EJECT_SECONDS", "300"))
state = {"fail": {}, "ejected": {}, "rr": 0}
lock = threading.Lock()


def log(level, msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [{level}] {msg}\n")
    sys.stderr.flush()


def endpoints():
    try:
        return sorted({a[4][0] for a in socket.getaddrinfo(PEERS, 8080, socket.AF_INET)})
    except OSError:
        return []


def pick():
    now = time.time()
    with lock:
        healthy = [ip for ip in endpoints() if state["ejected"].get(ip, 0) < now]
        if not healthy:
            return None
        state["rr"] += 1
        return healthy[state["rr"] % len(healthy)]


def record(ip, ok):
    with lock:
        if ok:
            state["fail"][ip] = 0
            return
        state["fail"][ip] = state["fail"].get(ip, 0) + 1
        if state["fail"][ip] >= 3 and state["ejected"].get(ip, 0) < time.time():
            state["ejected"][ip] = time.time() + EJECT
            log("WARN", f"circuit breaker: endpoint {ip}:8080 EJECTED for {EJECT}s after 3 consecutive failures")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, "ok\n", "text/plain")
        if self.path == "/breaker":
            now = time.time()
            with lock:
                table = [{"endpoint": f"{ip}:8080", "status": "EJECTED" if until > now else "HEALTHY", "ejected_for_s": max(0, int(until - now))} for ip, until in sorted(state["ejected"].items())]
            return self._send(200, json.dumps({"endpoints": endpoints(), "breaker": table}) + "\n")
        if self.path != "/order":
            return self._send(404, "{}")
        ip = pick()
        if ip is None:
            log("ERROR", "no healthy payment endpoint (circuit open)")
            return self._send(503, '{"error":"payment service unavailable (circuit open)"}\n')
        try:
            with urllib.request.urlopen(f"http://{ip}:8080/pay", timeout=2) as r:
                r.read()
            record(ip, True)
            self._send(200, '{"order":"ok"}\n')
        except Exception as e:  # noqa: BLE001
            record(ip, False)
            log("WARN", f"payment {ip}:8080 failed: {e.__class__.__name__} (timeout 2s)")
            self._send(503, '{"error":"payment service timeout"}\n')

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", f"order-service: payment peers via {PEERS}, breaker eject {EJECT}s")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
