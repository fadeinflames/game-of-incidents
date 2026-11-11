#!/usr/bin/env python3
"""storage-api: the HTTP front of the metadata tier of an object store.

GET    /objects/<path>   where the object lives (one row of the objects table)
PUT    /objects/<path>   create or replace the metadata of an object
DELETE /objects/<path>   remove it
GET    /healthz          the database answers SELECT 1

Every request opens its own database session; a query that runs longer than statement_timeout_ms is cancelled.
"""
import configparser
import hashlib
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg2
import psycopg2.errors

CONF = "/etc/storage-api/api.conf"

SQL_GET = "SELECT path, owner, etag, size_bytes, replicas, headers, updated_at FROM objects WHERE path = %s"
SQL_PUT = """INSERT INTO objects (path, owner, etag, size_bytes, replicas, headers)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (path) DO UPDATE SET etag = EXCLUDED.etag, size_bytes = EXCLUDED.size_bytes,
  replicas = EXCLUDED.replicas, headers = EXCLUDED.headers, updated_at = now()
RETURNING etag"""
SQL_DELETE = "DELETE FROM objects WHERE path = %s"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} storage-api: {msg}", flush=True)


def read_conf():
    cp = configparser.ConfigParser()
    if not cp.read(CONF):
        raise SystemExit(f"storage-api: cannot read {CONF}")
    return {
        "host": cp.get("api", "listen_host", fallback="127.0.0.1"),
        "port": cp.getint("api", "listen_port", fallback=8080),
        "dsn": cp.get("database", "dsn"),
        "timeout_ms": cp.getint("database", "statement_timeout_ms", fallback=4000),
    }


CONFIG = {}


def pg_error(e):
    text = (getattr(e, "pgerror", None) or str(e) or e.__class__.__name__).strip()
    return text.splitlines()[0].replace('"', "'") if text else e.__class__.__name__


def placement(path):
    h = hashlib.md5(path.encode()).hexdigest()
    return [
        {"node": f"stor-{1 + int(h[:4], 16) % 48}.dc1.internal", "volume": h, "checksum": h + h[::-1]},
        {"node": f"stor-{1 + int(h[4:8], 16) % 52}.dc2.internal", "volume": h[::-1], "checksum": h + h[::-1]},
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "storage-api/3.8"

    def log_message(self, fmt, *args):  # the access log is written by reply()
        return

    def reply(self, status, doc, started, error=None):
        body = (json.dumps(doc, default=str) + "\n").encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass  # the client has gone away
        ms = int((time.monotonic() - started) * 1000)
        line = f"{self.command} {self.path} {status} {ms}ms"
        if error:
            line += f' error="{error}"'
        log(line)

    def run(self, work):
        """Open a session, run the work, map database errors to HTTP statuses."""
        started = time.monotonic()
        conn = None
        try:
            conn = psycopg2.connect(CONFIG["dsn"], options=f"-c statement_timeout={CONFIG['timeout_ms']}",
                                    application_name="storage-api")
            conn.autocommit = True
            with conn.cursor() as cur:
                status, doc = work(cur)
            self.reply(status, doc, started)
        except psycopg2.errors.QueryCanceled as e:
            self.reply(504, {"error": "metadata query timed out"}, started, pg_error(e))
        except psycopg2.OperationalError as e:
            self.reply(503, {"error": "metadata tier unavailable"}, started, pg_error(e))
        except psycopg2.Error as e:
            self.reply(500, {"error": "metadata query failed"}, started, pg_error(e))
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass

    def object_path(self):
        if not self.path.startswith("/objects/") or len(self.path) <= len("/objects/"):
            return None
        return self.path[len("/objects"):].split("?", 1)[0]

    def do_GET(self):  # noqa: N802
        if self.path == "/healthz":
            def work(cur):
                cur.execute("SELECT 1")
                return 200, {"status": "ok"}
            return self.run(work)
        path = self.object_path()
        if path is None:
            return self.reply(404, {"error": "not found"}, time.monotonic())

        def work(cur):
            cur.execute(SQL_GET, (path,))
            row = cur.fetchone()
            if row is None:
                return 404, {"error": "no such object", "path": path}
            keys = ("path", "owner", "etag", "size_bytes", "replicas", "headers", "updated_at")
            return 200, dict(zip(keys, row))
        return self.run(work)

    def do_PUT(self):  # noqa: N802
        path = self.object_path()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b""
        if path is None:
            return self.reply(404, {"error": "not found"}, time.monotonic())
        owner = path.strip("/").split("/", 1)[0]
        etag = hashlib.md5(body).hexdigest()
        headers = {"content-type": self.headers.get("Content-Type") or "application/octet-stream",
                   "x-durability-level": "2", "x-request-id": self.headers.get("X-Request-Id") or etag}

        def work(cur):
            cur.execute(SQL_PUT, (path, owner, etag, len(body), json.dumps(placement(path)), json.dumps(headers)))
            return 200, {"path": path, "etag": cur.fetchone()[0]}
        return self.run(work)

    def do_DELETE(self):  # noqa: N802
        path = self.object_path()
        if path is None:
            return self.reply(404, {"error": "not found"}, time.monotonic())

        def work(cur):
            cur.execute(SQL_DELETE, (path,))
            return (200, {"path": path, "deleted": True}) if cur.rowcount else (404, {"error": "no such object", "path": path})
        return self.run(work)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128


def main():
    CONFIG.update(read_conf())
    srv = Server((CONFIG["host"], CONFIG["port"]), Handler)
    log(f"listening on {CONFIG['host']}:{CONFIG['port']}, statement timeout {CONFIG['timeout_ms']} ms")
    srv.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
