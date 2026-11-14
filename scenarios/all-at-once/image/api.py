#!/usr/bin/env python3
"""alerts-api: what users do with security alerts of their repositories.

GET  /health                       the process answers (no database involved)
GET  /alerts/<id>                  one alert
GET  /repos/<id>/alerts            the alerts of a repository
POST /alerts/<id>/dismiss          the user dismisses the alert
POST /alerts/<id>/resolve          the user marks it as fixed
POST /alerts/<id>/reopen           back to open
Every request that needs the database opens a connection, uses it and closes it.
A database error is answered with 503 and the text of the error; every request is written to the log.
"""
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql

DB = dict(
    host=os.environ.get("DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("DB_PORT", "3306")),
    user=os.environ["API_DB_USER"],
    password=os.environ["API_DB_PASSWORD"],
    database=os.environ.get("DB_NAME", "secalerts"),
    connect_timeout=3,
    read_timeout=10,
    write_timeout=10,
    charset="utf8mb4",
)
HOST, _, PORT = os.environ.get("API_LISTEN", "127.0.0.1:8080").partition(":")
ACTIONS = {"dismiss": "dismissed", "resolve": "resolved", "reopen": "open"}
ALERT = re.compile(r"^/alerts/(\d+)$")
ACTION = re.compile(r"^/alerts/(\d+)/(dismiss|resolve|reopen)$")
REPO = re.compile(r"^/repos/(\d+)/alerts$")
COLUMNS = "id, advisory_id, repo_id, state, severity, created_at, updated_at"


def log(msg):
    print("%s alerts-api: %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg), flush=True)


def as_doc(row):
    return {"id": row[0], "advisory_id": row[1], "repo_id": row[2], "state": row[3], "severity": row[4],
            "created_at": str(row[5]), "updated_at": str(row[6])}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def _send(self, code, body, started, error=None):
        data = (json.dumps(body, ensure_ascii=False) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        if self.path != "/health":
            took = int((time.monotonic() - started) * 1000)
            log("%s %s %d %dms%s" % (self.command, self.path, code, took, " error=%s" % error if error else ""))

    def _db(self, started, work):
        try:
            conn = pymysql.connect(**DB)
            try:
                code, body = work(conn)
                conn.commit()
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            text = " ".join(str(e).split())
            return self._send(503, {"error": "database: %s" % text}, started, error=text)
        self._send(code, body, started)

    def do_GET(self):
        started = time.monotonic()
        if self.path == "/health":
            return self._send(200, {"ok": True}, started)
        one, repo = ALERT.match(self.path), REPO.match(self.path)
        if one:
            def work(conn):
                with conn.cursor() as cur:
                    cur.execute("SELECT %s FROM alerts WHERE id = %%s" % COLUMNS, (int(one.group(1)),))
                    row = cur.fetchone()
                return (200, as_doc(row)) if row else (404, {"error": "no such alert"})
            return self._db(started, work)
        if repo:
            def work(conn):
                with conn.cursor() as cur:
                    cur.execute("SELECT %s FROM alerts WHERE repo_id = %%s ORDER BY id DESC LIMIT 50" % COLUMNS, (int(repo.group(1)),))
                    return 200, {"alerts": [as_doc(r) for r in cur.fetchall()]}
            return self._db(started, work)
        self._send(404, {"error": "not found"}, started)

    def do_POST(self):
        started = time.monotonic()
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        m = ACTION.match(self.path)
        if not m:
            return self._send(404, {"error": "not found"}, started)
        alert_id, state = int(m.group(1)), ACTIONS[m.group(2)]

        def work(conn):
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM alerts WHERE id = %s", (alert_id,))
                if cur.fetchone() is None:
                    return 404, {"error": "no such alert"}
                cur.execute("UPDATE alerts SET state = %s, updated_at = NOW() WHERE id = %s", (state, alert_id))
            return 200, {"id": alert_id, "state": state}
        self._db(started, work)

    def log_message(self, *_args):
        pass


def main():
    server = ThreadingHTTPServer((HOST, int(PORT or 8080)), Handler)
    server.daemon_threads = True
    log("listening on %s:%s" % (HOST, PORT))
    server.serve_forever()


if __name__ == "__main__":
    main()
