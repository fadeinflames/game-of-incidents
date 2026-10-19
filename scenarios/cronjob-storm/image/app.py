#!/usr/bin/env python3
"""api: GET /health -> 200; GET / -> greeting."""
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, "ok\n")
        elif self.path == "/":
            self._send(200, f"api on {os.environ.get('HOSTNAME', '?')}\n")
        else:
            self._send(404, "not found\n")

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("%s - - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
