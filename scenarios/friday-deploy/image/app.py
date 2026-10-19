#!/usr/bin/env python3
"""api-backend: GET /health, GET /api/orders, POST /upload. Version 2.1.3 ("large file uploads") keeps every upload
buffer referenced after the request is done: a memory leak that the container's limit turns into OOMKilled."""
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

VERSION = os.environ.get("APP_VERSION", "2.1.2")
LEAK = os.environ.get("UPLOAD_CACHE", "off") == "on"
retained = []  # v2.1.3: "upload cache" that is never evicted
started = time.time()


def log(level, msg):
    sys.stderr.write(f"[{level}] {msg}\n")
    sys.stderr.flush()


def rss_mb():
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 0


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
        elif self.path.startswith("/api/"):
            self._send(200, f'{{"version":"{VERSION}","orders":[1,2,3]}}\n')
        else:
            self._send(404, "not found\n")

    def do_POST(self):
        if self.path != "/upload":
            return self._send(404, "not found\n")
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if LEAK:
            retained.append(bytearray(body) + bytearray(4 * 1024 * 1024))  # v2.1.3: cache the decoded file "for retries"
            mb = rss_mb()
            if mb and mb % 16 < 3:
                log("WARN", f"Memory usage: {mb}MB (upload cache: {len(retained)} entries)")
        self._send(200, f"stored {n} bytes\n")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", f"Starting api-backend v{VERSION} (upload cache: {'on' if LEAK else 'off'})")
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
