#!/usr/bin/env python3
"""payment-service: GET /pay -> 200 after ~50 ms; GET /health -> 200."""
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ZONE = os.environ.get("ZONE", "?")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/pay":
            time.sleep(0.05)
        body = b'{"status":"ok"}\n'
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
    sys.stderr.write(f"[INFO] payment-service in zone {ZONE}\n")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
