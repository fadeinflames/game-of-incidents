#!/usr/bin/env python3
"""Customer traffic: 10 orders per second through the order-service Service; GET /stats on :9090 -> last-60s success rate."""
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

TARGET = os.environ.get("TARGET", "http://order-service")
events = deque()
lock = threading.Lock()


def record(ok):
    now = time.time()
    with lock:
        events.append((now, ok))
        while events and now - events[0][0] > 60:
            events.popleft()


def call():
    try:
        with urllib.request.urlopen(TARGET + "/order", timeout=4) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500
    except Exception:  # noqa: BLE001
        return False


def worker():
    while True:
        t0 = time.time()
        record(call())
        time.sleep(max(0, 0.5 - (time.time() - t0)))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with lock:
            total = len(events)
            ok = sum(1 for _, o in events if o)
        body = json.dumps({"window_s": 60, "requests": total, "ok": ok, "success_rate": round(ok / total, 3) if total else None}).encode()
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
    sys.stderr.write(f"loadgen: hitting {TARGET}\n")
    for _ in range(5):
        threading.Thread(target=worker, daemon=True).start()
    HTTPServer(("0.0.0.0", 9090), Handler).serve_forever()
