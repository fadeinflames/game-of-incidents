#!/usr/bin/env python3
"""events (kafka-like) / store (cassandra-like) / app-api stand-ins: GET /health -> 200; stateful roles keep a marker
in their data volume and log whether they joined with data or had to bootstrap."""
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROLE = os.environ.get("ROLE", "app")
PORT = int(os.environ.get("PORT", "8080"))
DATA = os.environ.get("DATADIR")

if DATA:
    os.makedirs(DATA, exist_ok=True)
    marker = os.path.join(DATA, "MEMBER")
    if os.path.exists(marker):
        sys.stderr.write(f"[INFO] {ROLE}: data directory present, rejoining ({open(marker).read().strip()})\n")
    else:
        with open(marker, "w") as fh:
            fh.write(f"{os.environ.get('HOSTNAME', '?')} initialised {time.strftime('%F %T')}\n")
        sys.stderr.write(f"[WARN] {ROLE}: empty data directory, streaming replicas from peers (this takes a while on real data)\n")
    sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok\n" if self.path == "/health" else f"{ROLE} on {os.environ.get('HOSTNAME', '?')}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
