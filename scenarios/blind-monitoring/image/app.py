#!/usr/bin/env python3
"""checkout: GET /metrics in Prometheus text format (requests counter, up gauge), GET /health."""
import os
import random
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

started = time.time()
requests_total = 0


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global requests_total
        if self.path == "/metrics":
            requests_total += random.randint(3, 9)
            body = (
                "# HELP checkout_requests_total Requests served.\n# TYPE checkout_requests_total counter\n"
                f"checkout_requests_total {requests_total}\n"
                "# HELP checkout_up 1 if the service is healthy.\n# TYPE checkout_up gauge\ncheckout_up 1\n"
                f"process_uptime_seconds {int(time.time() - started)}\n"
            ).encode()
            ctype = "text/plain; version=0.0.4"
        else:
            body = b"ok\n"
            ctype = "text/plain"
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
    sys.stderr.write(f"[INFO] checkout started on {os.environ.get('HOSTNAME', '?')}\n")
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
