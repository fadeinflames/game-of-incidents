#!/usr/bin/env python3
"""board-api: the read API of the task board.

GET /users/<id>          profile
GET /users/<id>/tasks    open tasks of the user, nearest due date first
GET /users/<id>/feed     the user's latest comments
GET /health              every shard answers SELECT 1
GET /admin/settings      the settings the running service uses right now

A user lives on one of three shards, chosen by the id range (see SHARDS).
Settings come from /etc/board-api/settings.conf. The file is read at start and on SIGHUP (service board-api reload).
A database error is written to the log with the failed query; the client gets a plain 500.
"""
import json
import os
import re
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql

SETTINGS_FILE = "/etc/board-api/settings.conf"
ACCESS_LOG = "/var/log/board-api/access.log"
DB = dict(
    host=os.environ.get("DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("DB_PORT", "3306")),
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    connect_timeout=3,
    read_timeout=10,
    charset="utf8mb4",
)
HOST, _, PORT = os.environ.get("LISTEN", "127.0.0.1:8080").partition(":")
SHARDS = ((1000, 1999, "board_s1"), (2000, 2999, "board_s2"), (3000, 3999, "board_s3"))

DEFAULTS = {"page_size": 20, "tasks_list_index": None, "feed_index": None}
OFF = {"", "off", "none", "no", "false", "0", "-"}
IDENT = re.compile(r"^[A-Za-z0-9_]{1,64}$")
ROUTE = re.compile(r"^/users/(\d{1,9})(/tasks|/feed)?/?$")

settings = dict(DEFAULTS)
loaded_at = None
access_lock = threading.Lock()
access_file = None


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} board-api: {msg}", flush=True)


def parse_settings(path):
    values = dict(DEFAULTS)
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if "=" not in line:
                raise ValueError(f"line {n}: expected 'key = value'")
            key, value = (part.strip() for part in line.split("=", 1))
            value = value.strip("'\"").strip()
            if key == "page_size":
                if not value.isdigit() or not 1 <= int(value) <= 100:
                    raise ValueError(f"line {n}: page_size must be a number from 1 to 100")
                values[key] = int(value)
            elif key in ("tasks_list_index", "feed_index"):
                if value.lower() in OFF:
                    values[key] = None
                elif IDENT.match(value):
                    values[key] = value
                else:
                    raise ValueError(f"line {n}: {key}: {value!r} is not an index name")
            else:
                log(f"settings: line {n}: unknown key {key!r} is ignored")
    return values


def load_settings(reason):
    """Read the settings file. A file with a mistake is rejected as a whole and the previous settings stay."""
    global settings, loaded_at
    try:
        values = parse_settings(SETTINGS_FILE)
    except FileNotFoundError:
        log(f"settings ({reason}): {SETTINGS_FILE} not found, using the defaults")
        values = dict(DEFAULTS)
    except (OSError, ValueError, UnicodeDecodeError) as e:
        log(f"settings ({reason}): REJECTED, {e}; the previous settings stay in effect")
        return
    settings = values
    loaded_at = now()
    shown = ", ".join(f"{k}={'(off)' if v is None else v}" for k, v in values.items())
    log(f"settings ({reason}): {shown}")


def shard_of(user_id):
    for low, high, name in SHARDS:
        if low <= user_id <= high:
            return name
    return None


def hint(index):
    return f" FORCE INDEX ({index})" if index else ""


def access(path, status, shard, started):
    if access_file is None:
        return
    ms = int((time.monotonic() - started) * 1000)
    with access_lock:
        access_file.write(f"{now()} GET {path} {status} shard={shard or '-'} {ms}ms\n")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = (json.dumps(body, ensure_ascii=False) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        started = time.monotonic()
        path = self.path.split("?", 1)[0]
        status, body, shard = self.answer(path)
        try:
            self._send(status, body)
        except OSError:
            pass
        if path.startswith("/users/"):
            access(path, status, shard, started)

    def answer(self, path):
        if path == "/health":
            return self.health()
        if path == "/admin/settings":
            return 200, dict(settings, loaded_at=loaded_at, source=SETTINGS_FILE), None
        m = ROUTE.match(path)
        if not m:
            return 404, {"error": "not found"}, None
        user_id, page = int(m.group(1)), m.group(2) or ""
        shard = shard_of(user_id)
        if shard is None:
            return 404, {"error": "user not found"}, None
        cfg = settings  # one consistent snapshot for the whole request
        if page == "/tasks":
            sql = ("SELECT id, title, due FROM tasks" + hint(cfg["tasks_list_index"])
                   + " WHERE owner_id = %s AND state = 'open' ORDER BY due, id LIMIT %s")
            args = (user_id, cfg["page_size"])
        elif page == "/feed":
            sql = ("SELECT id, task_id, body, created_at FROM comments" + hint(cfg["feed_index"])
                   + " WHERE author_id = %s ORDER BY created_at DESC, id DESC LIMIT %s")
            args = (user_id, cfg["page_size"])
        else:
            sql = "SELECT id, name, plan FROM users WHERE id = %s"
            args = (user_id,)
        try:
            conn = pymysql.connect(database=shard, **DB)
            try:
                with conn.cursor() as cur:
                    cur.execute(sql, args)
                    rows = cur.fetchall()
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            log(f"GET {path} -> 500 shard={shard} db error: {e} | query: {sql}")
            return 500, {"error": "internal server error"}, shard
        if page == "/tasks":
            tasks = [{"id": r[0], "title": r[1], "due": str(r[2])} for r in rows]
            return 200, {"user_id": user_id, "shard": shard, "tasks": tasks}, shard
        if page == "/feed":
            comments = [{"id": r[0], "task_id": r[1], "body": r[2], "created_at": str(r[3])} for r in rows]
            return 200, {"user_id": user_id, "shard": shard, "comments": comments}, shard
        if not rows:
            return 404, {"error": "user not found"}, shard
        return 200, {"id": rows[0][0], "name": rows[0][1], "plan": rows[0][2], "shard": shard}, shard

    def health(self):
        state, ok = {}, True
        for _low, _high, shard in SHARDS:
            try:
                conn = pymysql.connect(database=shard, **DB)
                try:
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1")
                finally:
                    conn.close()
                state[shard] = "ok"
            except pymysql.MySQLError as e:
                state[shard] = "down"
                ok = False
                log(f"GET /health: shard={shard} db error: {e}")
        return (200 if ok else 503), {"ok": ok, "shards": state}, None

    def log_message(self, *_args):
        pass


def main():
    global access_file
    try:
        access_file = open(ACCESS_LOG, "a", buffering=1, encoding="utf-8")
    except OSError as e:
        log(f"access log {ACCESS_LOG} is not writable ({e}), requests are not logged")
    load_settings("start")
    signal.signal(signal.SIGHUP, lambda *_: load_settings("reload"))
    server = ThreadingHTTPServer((HOST, int(PORT or 8080)), Handler)
    server.daemon_threads = True
    log(f"listening on {HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
