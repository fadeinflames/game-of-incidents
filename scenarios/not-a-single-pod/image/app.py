#!/usr/bin/env python3
"""Stage application stub: GET / -> name and pod; GET /healthz -> 200 ok; anything else -> 404."""
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

APP_NAME = os.environ.get("APP_NAME", "app")
APP_VERSION = os.environ.get("APP_VERSION", "0.0.0")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            self._send(200, "ok\n")
        elif self.path == "/":
            self._send(200, f"{APP_NAME} v{APP_VERSION} on {os.environ.get('HOSTNAME', '?')}\n")
        else:
            self._send(404, "not found\n")

    def log_message(self, fmt, *args):  # noqa: N802
        if "/healthz" in (fmt % args):
            return  # probes would drown the log
        sys.stderr.write("%s - - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write(f"{APP_NAME} v{APP_VERSION} listening on :8080\n")
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
