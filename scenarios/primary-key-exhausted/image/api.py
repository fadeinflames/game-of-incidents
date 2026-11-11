#!/usr/bin/env python3
"""tracker-api: records user actions.

POST /events          {"user_id": 1, "kind": "comment"} -> 201 {"id": ...}; the event and its index row go in one transaction
GET  /events/recent   the ten newest events
GET  /health          the database answers
Any database error is returned as 500 with the text of the error and written to the log.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql

DB = dict(
    host=os.environ.get("DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("DB_PORT", "3306")),
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    database=os.environ.get("DB_NAME", "tracker"),
    connect_timeout=3,
    charset="utf8mb4",
)
HOST, _, PORT = os.environ.get("LISTEN", "127.0.0.1:8080").partition(":")
BUCKETS = 16


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} tracker-api: {msg}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = (json.dumps(body, ensure_ascii=False) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            conn = pymysql.connect(**DB)
            try:
                with conn.cursor() as cur:
                    if self.path == "/health":
                        cur.execute("SELECT 1")
                        return self._send(200, {"ok": True})
                    if self.path == "/events/recent":
                        cur.execute("SELECT id, user_id, kind, created_at FROM events ORDER BY id DESC LIMIT 10")
                        rows = [{"id": r[0], "user_id": r[1], "kind": r[2], "created_at": str(r[3])} for r in cur.fetchall()]
                        return self._send(200, {"events": rows})
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            log(f"GET {self.path} failed: {e}")
            return self._send(500, {"error": str(e)})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/events":
            return self._send(404, {"error": "not found"})
        try:
            doc = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            user_id, kind = int(doc["user_id"]), str(doc["kind"])[:32]
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad request"})
        try:
            conn = pymysql.connect(**DB)
            try:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO events (user_id, kind, created_at) VALUES (%s, %s, NOW())", (user_id, kind))
                    event_id = cur.lastrowid
                    cur.execute("INSERT INTO event_index (event_id, user_id, bucket) VALUES (%s, %s, %s)", (event_id, user_id, user_id % BUCKETS))
                conn.commit()
            except pymysql.MySQLError:
                conn.rollback()
                raise
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            log(f"POST /events failed: {e}")
            return self._send(500, {"error": str(e)})
        self._send(201, {"id": event_id})

    def log_message(self, *_args):
        pass


def main():
    server = ThreadingHTTPServer((HOST, int(PORT or 8080)), Handler)
    server.daemon_threads = True
    log(f"listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
