#!/usr/bin/env python3
"""web-app: needs DATABASE_PASSWORD to start; GET /health -> 200; GET /config -> JSON with the timeout it runs with."""
import json
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

TIMEOUT = os.environ.get("API_TIMEOUT", "10")
DB_HOST = os.environ.get("DATABASE_HOST", "postgres")
DB_PASSWORD = os.environ.get("DATABASE_PASSWORD")

if not DB_PASSWORD:
    sys.stderr.write("[ERROR] Missing required environment variable: DATABASE_PASSWORD\n")
    sys.stderr.write("[ERROR] Please set DATABASE_PASSWORD in environment\n")
    sys.stderr.flush()
    time.sleep(2)  # keep the log readable before the container dies
    sys.exit(1)

sys.stderr.write(f"[INFO] web-app started: timeout={TIMEOUT}s db={DB_HOST} log_level={os.environ.get('LOG_LEVEL', 'info')}\n")
sys.stderr.flush()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, "ok\n")
        elif self.path == "/config":
            self._send(200, json.dumps({"api_timeout": int(TIMEOUT), "database_host": DB_HOST}) + "\n", "application/json")
        elif self.path == "/":
            self._send(200, f"web-app on {os.environ.get('HOSTNAME', '?')} timeout={TIMEOUT}\n")
        else:
            self._send(404, "not found\n")

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("%s - - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
