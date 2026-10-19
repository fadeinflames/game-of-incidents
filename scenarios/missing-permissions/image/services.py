#!/usr/bin/env python3
"""Two tiny services selected by ROLE:
- database: POST /dump with header X-Db-Password (must match DB_PASSWORD) -> a dump; anything else 401
- backup-store: PUT /snapshots/<name> stores a blob, GET /snapshots lists them (name, size, age) as JSON
"""
import json
import os
import signal
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROLE = os.environ.get("ROLE", "database")
STORE = os.environ.get("STORE", "/tmp/snapshots")
snapshots = {}


class Database(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/plain"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, "ok\n" if self.path == "/health" else "database\n")

    def do_POST(self):
        if self.path != "/dump":
            return self._send(404, "not found\n")
        if self.headers.get("X-Db-Password") != os.environ.get("DB_PASSWORD"):
            sys.stderr.write("[WARN] dump refused: bad or missing password\n")
            return self._send(401, "authentication failed for user backup\n")
        body = "-- PostgreSQL database dump (model)\n" + "".join(f"INSERT INTO orders VALUES ({i}, 'order-{i}');\n" for i in range(1, 2001))
        self._send(200, body, "application/sql")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


class Store(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, "ok\n", "text/plain")
        if self.path.startswith("/snapshots"):
            now = time.time()
            items = [{"name": n, "bytes": s["bytes"], "age_s": int(now - s["ts"])} for n, s in sorted(snapshots.items(), key=lambda kv: kv[1]["ts"], reverse=True)]
            return self._send(200, json.dumps({"snapshots": items}) + "\n")
        self._send(404, "{}")

    def do_PUT(self):
        if not self.path.startswith("/snapshots/"):
            return self._send(404, "{}")
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        name = self.path.split("/snapshots/", 1)[1]
        snapshots[name] = {"bytes": len(data), "ts": time.time()}
        try:
            os.makedirs(STORE, exist_ok=True)
            with open(os.path.join(STORE, name), "wb") as fh:
                fh.write(data)
        except OSError as e:
            sys.stderr.write(f"[WARN] snapshot kept in memory only: {e}\n")
        sys.stderr.write(f"[INFO] stored {name} ({len(data)} bytes)\n")
        self._send(201, json.dumps({"stored": name, "bytes": len(data)}) + "\n")

    def do_DELETE(self):
        name = self.path.split("/snapshots/", 1)[-1]
        snapshots.pop(name, None)
        self._send(200, "{}")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if ROLE == "backup-store":
        # seed: nightly snapshots of the last days (so "today's is missing" is visible)
        for d in range(1, 4):
            snapshots[f"orders-{time.strftime('%Y%m%d', time.gmtime(time.time() - d * 86400))}-0230.sql"] = {"bytes": 118_000 + d * 37, "ts": time.time() - d * 86400 - 5 * 3600}
        ThreadingHTTPServer(("0.0.0.0", 8080), Store).serve_forever()
    else:
        ThreadingHTTPServer(("0.0.0.0", 5432), Database).serve_forever()
