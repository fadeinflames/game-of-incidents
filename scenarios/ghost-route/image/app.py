#!/usr/bin/env python3
"""api (ROLE=api): GET /api/* -> JSON. web (ROLE=web): a static server, / and /index.html -> the SPA's index.html, anything else 404. Client-side routes
(/products/42) work only because the ingress rewrites them to /index.html (the catalog-v2 Ingress does that)."""
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROLE = os.environ.get("ROLE", "api")
INDEX = """<!doctype html><html><head><title>shop</title></head><body>
<div id="app">catalog v2 loading…</div><script src="/static/app.js"></script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, "ok\n", "text/plain")
        if ROLE == "api":
            if self.path.startswith("/api/orders"):
                return self._send(200, json.dumps({"orders": [{"id": 1042, "total": 1990}, {"id": 1043, "total": 450}]}) + "\n", "application/json")
            if self.path.startswith("/api/"):
                return self._send(200, json.dumps({"ok": True, "path": self.path}) + "\n", "application/json")
            return self._send(404, json.dumps({"error": "not found"}) + "\n", "application/json")
        # web: static server, no SPA fallback of its own
        if self.path.startswith("/static/"):
            return self._send(200, "console.log('catalog v2');\n", "application/javascript")
        if self.path in ("/", "/index.html"):
            return self._send(200, INDEX, "text/html; charset=utf-8")
        return self._send(404, "not found\n", "text/plain")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write(f"[INFO] {ROLE} started\n")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
