#!/usr/bin/env python3
"""recommendation-api: GET /recommend -> a few ids; every request writes an access log line to LOG_DIR/app.log.
With DEBUG_PAYLOAD=on each line also carries the full feature vector of the request (~200 KB), which is how a
"let's debug in prod" toggle turns into a flood. GET /health -> 200."""
import json
import os
import random
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG_DIR = os.environ.get("LOG_DIR", "/var/log/app")
DEBUG = os.environ.get("DEBUG_PAYLOAD", "off") == "on"
os.makedirs(LOG_DIR, exist_ok=True)
LOG = open(os.path.join(LOG_DIR, "app.log"), "a", buffering=1)
FEATURES = {"user_embedding": [round(random.random(), 6) for _ in range(6000)], "item_scores": [round(random.random(), 6) for _ in range(12000)]}


def write_log(entry):
    try:
        LOG.write(json.dumps(entry) + "\n")
    except OSError as e:
        sys.stderr.write(f"[ERROR] cannot write log: {e}\n")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, '{"status":"ok"}\n')
        ids = random.sample(range(1000, 9999), 5)
        entry = {"ts": time.time(), "path": self.path, "recommendations": ids, "latency_ms": random.randint(4, 30)}
        if DEBUG:
            entry["debug"] = {"level": "DEBUG", "features": FEATURES, "model": "rec-v14", "explain": "full feature dump for debugging"}
        write_log(entry)
        self._send(200, json.dumps({"recommendations": ids}) + "\n")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod.
    # The code is 143, like a process killed by SIGTERM: with 0 an evicted pod ends as Succeeded and loses its Evicted mark,
    # which this scenario (and its grader) rely on.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    sys.stderr.write(f"[INFO] recommendation-api started, debug payload: {'ON (every request dumps ~200 KB of features)' if DEBUG else 'off'}\n")
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
