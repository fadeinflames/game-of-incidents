#!/usr/bin/env python3
"""Customer traffic: 20 recommendation requests per second through the Service; GET /stats -> last-60s success rate."""
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

TARGET = os.environ.get("TARGET", "http://recommendation-api")
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
        with urllib.request.urlopen(TARGET + "/recommend?user=42", timeout=3) as r:
            return r.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500
    except Exception:  # noqa: BLE001
        return False


def loop():
    while True:
        t0 = time.time()
        for _ in range(4):
            record(call())
        time.sleep(max(0, 0.2 - (time.time() - t0)))


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
    threading.Thread(target=loop, daemon=True).start()
    HTTPServer(("0.0.0.0", 9090), Handler).serve_forever()
