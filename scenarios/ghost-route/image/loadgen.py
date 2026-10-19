#!/usr/bin/env python3
"""Clients through the ingress: the mobile app calls api.shop.local/api/orders and expects JSON; browsers open
shop.local/ and shop.local/products/42 and expect HTML. GET /stats on :9090 -> last-60s success rate per client."""
import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer

INGRESS = os.environ.get("INGRESS", "http://ingress-nginx-controller.ingress-nginx.svc")
events = {"mobile": deque(), "browser": deque()}
lock = threading.Lock()


def record(kind, ok):
    now = time.time()
    with lock:
        q = events[kind]
        q.append((now, ok))
        while q and now - q[0][0] > 60:
            q.popleft()


def get(host, path):
    req = urllib.request.Request(INGRESS + path, headers={"Host": host})
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read(200)
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), b""
    except Exception:  # noqa: BLE001
        return 0, "", b""


def loop():
    while True:
        code, ctype, body = get("api.shop.local", "/api/orders")
        record("mobile", code == 200 and "application/json" in ctype and b"orders" in body)
        for p in ("/", "/products/42"):
            code, ctype, _ = get("shop.local", p)
            record("browser", code == 200 and "text/html" in ctype)
        time.sleep(0.5)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        out = {}
        with lock:
            for k, q in events.items():
                total = len(q)
                ok = sum(1 for _, o in q if o)
                out[k] = {"requests": total, "ok": ok, "success_rate": round(ok / total, 3) if total else None}
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write(f"clients: via {INGRESS}\n")
    threading.Thread(target=loop, daemon=True).start()
    HTTPServer(("0.0.0.0", 9090), Handler).serve_forever()
