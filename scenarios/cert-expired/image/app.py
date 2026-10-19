#!/usr/bin/env python3
"""shop-frontend: GET / -> HTML, GET /health -> 200."""
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body, ctype = b"ok\n", "text/plain"
        else:
            body, ctype = b"<!doctype html><html><body><h1>shop</h1><p>open for business</p></body></html>\n", "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write("[INFO] shop-frontend started\n")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
