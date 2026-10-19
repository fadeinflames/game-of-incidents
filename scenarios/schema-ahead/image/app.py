#!/usr/bin/env python3
"""billing-api. v1 reads/writes invoices.total_cents. v2 reads/writes invoices.amount_cents and refuses to start
without BILLING_CURRENCY (a config key the v2 rollout forgot to ship)."""
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import pg8000.dbapi

VERSION = os.environ.get("APP_VERSION", "1.9.4")
COLUMN = "amount_cents" if VERSION.startswith("2.") else "total_cents"
CURRENCY = os.environ.get("BILLING_CURRENCY")


def log(level, msg):
    sys.stderr.write(f"[{level}] {msg}\n")
    sys.stderr.flush()


if VERSION.startswith("2.") and not CURRENCY:
    log("FATAL", "BILLING_CURRENCY is required since 2.0.0 (see release notes: multi-currency invoices)")
    sys.exit(1)


def connect():
    return pg8000.dbapi.connect(
        host=os.environ.get("PGHOST", "postgres"),
        user=os.environ.get("PGUSER", "billing"),
        password=os.environ.get("PGPASSWORD", "billing"),
        database=os.environ.get("PGDATABASE", "billing"),
        timeout=5,
    )


class Handler(BaseHTTPRequestHandler):
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
        if self.path != "/invoices":
            return self._send(404, "{}")
        try:
            conn = connect()
            cur = conn.cursor()
            cur.execute(f"SELECT id, customer, {COLUMN} FROM invoices ORDER BY id")
            rows = [{"id": r[0], "customer": r[1], "total_cents": r[2]} for r in cur.fetchall()]
            conn.close()
            self._send(200, json.dumps({"version": VERSION, "invoices": rows}) + "\n")
        except Exception as e:  # noqa: BLE001
            log("ERROR", f"SELECT id, customer, {COLUMN} FROM invoices -> {e}")
            self._send(500, json.dumps({"error": str(e)}) + "\n")

    def do_POST(self):
        if self.path != "/invoices":
            return self._send(404, "{}")
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
            conn = connect()
            cur = conn.cursor()
            cur.execute(f"INSERT INTO invoices (customer, {COLUMN}) VALUES (%s, %s) RETURNING id", (body.get("customer", "anon"), int(body.get("total_cents", 0))))
            new_id = cur.fetchone()[0]
            conn.commit()
            conn.close()
            self._send(201, json.dumps({"id": new_id}) + "\n")
        except Exception as e:  # noqa: BLE001
            log("ERROR", f"INSERT INTO invoices ({COLUMN}) -> {e}")
            self._send(500, json.dumps({"error": str(e)}) + "\n")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", f"billing-api v{VERSION} starting (column: {COLUMN}, currency: {CURRENCY or '-'})")
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
