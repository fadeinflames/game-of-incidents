#!/usr/bin/env python3
"""external-api-proxy (ROLE=proxy): once a second resolves the partner API name in the corporate zone and a cluster
name; GET /stats on :9090 -> last-60s resolution success per name. Other roles: plain /health services."""
import json
import os
import signal
import socket
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer

ROLE = os.environ.get("ROLE", "proxy")
NAMES = os.environ.get("RESOLVE", "payments-gateway.corp.internal,backend-api.shop.svc.cluster.local").split(",")
events = {n: deque() for n in NAMES}
lock = threading.Lock()


def log(level, msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [{level}] {msg}\n")
    sys.stderr.flush()


def resolver():
    while True:
        for n in NAMES:
            t0 = time.time()
            try:
                socket.getaddrinfo(n, 443, socket.AF_INET)
                ok = True
            except OSError as e:
                ok = False
                log("ERROR", f"lookup {n}: {e} ({int((time.time() - t0) * 1000)} ms)")
            now = time.time()
            with lock:
                q = events[n]
                q.append((now, ok))
                while q and now - q[0][0] > 60:
                    q.popleft()
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/stats" and ROLE == "proxy":
            with lock:
                out = {n: {"attempts": len(q), "ok": sum(1 for _, o in q if o), "success_rate": round(sum(1 for _, o in q if o) / len(q), 3) if q else None} for n, q in events.items()}
            body = json.dumps(out).encode()
        else:
            body = b"ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if self.path == "/stats" else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", f"{ROLE} started")
    if ROLE == "proxy":
        threading.Thread(target=resolver, daemon=True).start()
        HTTPServer(("0.0.0.0", 9090), Handler).serve_forever()
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
