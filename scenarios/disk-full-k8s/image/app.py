#!/usr/bin/env python3
"""blog-app: every request needs the database; GET /health mirrors the database health (liveness restarts us when it fails)."""
import json
import os
import signal
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

DB = os.environ.get("DB_URL", "http://mysql:3306")


def db_ok():
    try:
        with urllib.request.urlopen(DB + "/health", timeout=3) as r:
            return True, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return False, json.load(e)
        except Exception:  # noqa: BLE001
            return False, {"error": str(e)}
    except Exception as e:  # noqa: BLE001
        return False, {"error": str(e)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        ok, info = db_ok()
        if not ok:
            sys.stderr.write("WordPress: Error establishing database connection\n")
            if info.get("status") == "error":
                # the database answered and reported its own problem
                sys.stderr.write(f"MySQL Error: Can't create/write to file '/tmp/#sql_1234.MAI' (Errcode: 28) [{info.get('error')}]\n")
            else:
                # no answer at all: once mysql-0 is not Ready, the headless Service name stops resolving
                sys.stderr.write(f"MySQL Error: Can't connect to MySQL server on 'mysql' ({info.get('error')})\n")
            sys.stderr.flush()
            self._send(500, "Error establishing database connection\n")
        elif self.path == "/health":
            self._send(200, "ok\n")
        else:
            self._send(200, "blog: 1 284 posts, 9 311 comments\n")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
