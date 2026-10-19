#!/usr/bin/env python3
"""log-shipper sidecar (the Loki agent of the story): tails LOG_DIR/app.log and "ships" it at a fixed bandwidth.
When the app writes faster than the shipper reads, the backlog (unshipped bytes) grows: GET /metrics on :9102."""
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading

LOG_DIR = os.environ.get("LOG_DIR", "/var/log/app")
RATE = int(os.environ.get("SHIP_BYTES_PER_SEC", "300000"))
state = {"shipped": 0, "backlog": 0}


def tail():
    path = os.path.join(LOG_DIR, "app.log")
    pos = 0
    while True:
        try:
            size = os.path.getsize(path)
        except OSError:
            time.sleep(1)
            continue
        if size < pos:
            pos = 0
        chunk = min(RATE, size - pos)
        pos += chunk
        state["shipped"] += chunk
        state["backlog"] = size - pos
        if state["backlog"] > 8 * 1024 * 1024 and int(time.time()) % 15 == 0:
            sys.stderr.write(f"[WARN] backpressure: {state['backlog'] // 1024 // 1024} MiB of logs not yet shipped\n")
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"shipper_backlog_bytes {state['backlog']}\nshipper_shipped_bytes_total {state['shipped']}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod.
    # The code is 143, like a process killed by SIGTERM: with 0 an evicted pod ends as Succeeded and loses its Evicted mark,
    # which this scenario (and its grader) rely on.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    threading.Thread(target=tail, daemon=True).start()
    HTTPServer(("0.0.0.0", 9102), Handler).serve_forever()
