#!/usr/bin/env python3
"""Tiny orders API: POST /order inserts a row; GET /health checks the DB. 500 on any DB error (with the reason)."""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import psycopg2

DSN = os.environ["DATABASE_URL"]  # set by /etc/init.d/app from /etc/app/app.env
HOST, PORT = os.environ.get("LISTEN", "127.0.0.1:8080").split(":")


def db():
    return psycopg2.connect(DSN, connect_timeout=3)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            try:
                with db() as c, c.cursor() as cur:
                    cur.execute("SELECT 1")
                self._send(200, {"ok": True})
            except Exception as e:  # noqa: BLE001
                self._send(503, {"ok": False, "error": str(e).strip()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/order":
            self._send(404, {"error": "not found"})
            return
        try:
            with db() as c, c.cursor() as cur:
                cur.execute("INSERT INTO orders (amount, note) VALUES (%s, %s) RETURNING id", (49.90, "api"))
                oid = cur.fetchone()[0]
            self._send(201, {"id": oid})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e).strip()})

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("%s - - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    HTTPServer((HOST, int(PORT)), Handler).serve_forever()
