#!/usr/bin/env python3
"""gate-api: the HTTP front of the platform, as far as this host is concerned.

GET  /v1/projects/<id>              an authenticated request: the bearer token is looked up in the authz database
                                    and the permissions of its install are checked against the project
POST /v1/installs/<id>/access_tokens  issue a short-lived access token for an install of an integration
GET  /v1/status                     liveness of the API itself, no database involved

Every request takes one of a fixed number of request workers. Every database call opens its own session on the
primary: permission data must be fresh. A permission check that finds no free connection slot waits for one.
A token write that does not finish in time is tried again.
"""
import configparser
import hashlib
import json
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg2

CONF = "/etc/gate-api/api.conf"

SQL_AUTH = """SELECT i.project_id, i.permissions, g.slug
  FROM access_tokens t
  JOIN installs i ON i.id = t.install_id
  JOIN integrations g ON g.id = i.integration_id
 WHERE t.token_sha256 = %s AND t.expires_at > now()"""
# quota accounting: the counters of the integration move together with the token row
SQL_COUNT = """UPDATE integrations g
   SET tokens_issued = g.tokens_issued + 1, tokens_stored = g.tokens_stored + 1, last_issued_at = now()
  FROM installs i
 WHERE i.id = %s AND g.id = i.integration_id
RETURNING g.slug"""
SQL_INSERT = """INSERT INTO access_tokens (install_id, token_sha256, label, expires_at)
VALUES (%s, %s, %s, now() + %s * interval '1 minute')
RETURNING id, expires_at"""

RE_PROJECT = re.compile(r"^/v1/projects/(\d{1,9})$")
RE_TOKENS = re.compile(r"^/v1/installs/(\d{1,9})/access_tokens$")
RE_LABEL = re.compile(r"[^A-Za-z0-9._:-]")

CONFIG = {}
SLOTS = None
BUSY = 0
BUSY_LOCK = threading.Lock()


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} gate-api: {msg}", flush=True)


def read_conf():
    cp = configparser.ConfigParser()
    if not cp.read(CONF):
        raise SystemExit(f"gate-api: cannot read {CONF}")
    return {
        "host": cp.get("api", "listen_host", fallback="127.0.0.1"),
        "port": cp.getint("api", "listen_port", fallback=8080),
        "workers": max(1, cp.getint("api", "workers", fallback=12)),
        "queue_wait": cp.getfloat("api", "queue_wait_sec", fallback=2.0),
        "dsn": cp.get("database", "dsn"),
        "connect_wait": cp.getfloat("database", "connect_wait_sec", fallback=8.0),
        "ttl_min": cp.getint("tokens", "ttl_min", fallback=60),
        "attempt_timeout": cp.getfloat("tokens", "attempt_timeout_sec", fallback=3.0),
        "attempts": max(1, cp.getint("tokens", "attempts", fallback=5)),
        "retry_delay": cp.getfloat("tokens", "retry_delay_sec", fallback=0.3),
    }


def pg_error(e):
    text = (getattr(e, "pgerror", None) or str(e) or e.__class__.__name__).strip()
    line = text.splitlines()[-1] if "FATAL" in text else text.splitlines()[0]
    return " ".join(line.replace('"', "'").split())


def db_connect(wait=0.0):
    """A session on the primary. A permission check waits up to connect_wait_sec for a free connection slot."""
    deadline = time.monotonic() + wait
    while True:
        try:
            return psycopg2.connect(CONFIG["dsn"], application_name="gate-api")
        except psycopg2.OperationalError as e:
            busy = "connection slots" in str(e) or "too many clients" in str(e)
            if not busy or time.monotonic() + 1 > deadline:
                raise
            time.sleep(1)


def write_token(install_id, label, deadline, box):
    """One attempt to issue a token: bump the counters of the integration, insert the token row, commit."""
    conn = None
    try:
        conn = db_connect()
        with conn.cursor() as cur:
            cur.execute(SQL_COUNT, (install_id,))
            row = cur.fetchone()
            if row is None:
                conn.rollback()
                box["missing"] = True
                return
            if time.monotonic() > deadline:
                conn.rollback()  # the caller has stopped waiting for this attempt: no token nobody will receive
                return
            token = "gat_" + secrets.token_hex(20)
            cur.execute(SQL_INSERT, (install_id, hashlib.sha256(token.encode()).digest(), label, CONFIG["ttl_min"]))
            token_id, expires_at = cur.fetchone()
        conn.commit()
        box["result"] = {"id": token_id, "token": token, "integration": row[0], "expires_at": expires_at}
    except psycopg2.Error as e:
        box["error"] = pg_error(e)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def issue_token(install_id, label):
    """The token-issuing path: every attempt gets attempt_timeout_sec, a failed or late attempt is repeated."""
    attempts = CONFIG["attempts"]
    timeout = CONFIG["attempt_timeout"]
    late = False
    last = None
    for n in range(1, attempts + 1):
        box = {}
        worker = threading.Thread(target=write_token, args=(install_id, label, time.monotonic() + timeout, box),
                                  daemon=True)
        worker.start()
        worker.join(timeout)
        if "result" in box:
            return 201, box["result"], None
        if box.get("missing"):
            return 404, {"error": "no such install"}, None
        if "error" in box:
            last = box["error"]
            why = f"failed: {last}"
        else:
            late = True
            last = f"token write did not finish in {timeout:g} s"
            why = f"did not finish in {timeout:g} s"
        if n < attempts:
            log(f"WARN token write for install {install_id} {why}; retrying (attempt {n + 1}/{attempts})")
            time.sleep(CONFIG["retry_delay"])
    return (504 if late else 503), {"error": "token was not issued"}, f"{last}; gave up after {attempts} attempts"


def check_access(project_id, token):
    conn = None
    try:
        conn = db_connect(CONFIG["connect_wait"])
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(SQL_AUTH, (hashlib.sha256(token.encode()).digest(),))
            row = cur.fetchone()
    except psycopg2.Error as e:
        return 503, {"error": "permission check unavailable"}, pg_error(e)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
    if row is None:
        return 401, {"error": "bad credentials"}, None
    if row[0] != project_id:
        return 403, {"error": "the token has no access to this project"}, None
    return 200, {"project": project_id, "integration": row[2], "permissions": row[1]}, None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "gate-api/5.2"

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
        line = f"{self.command} {self.path.split('?', 1)[0]} {status} {ms}ms"
        if error:
            line += f' error="{error}"'
        log(line)

    def serve(self, work):
        """Take a request worker, do the work, give the worker back."""
        global BUSY
        started = time.monotonic()
        if not SLOTS.acquire(timeout=CONFIG["queue_wait"]):
            n = CONFIG["workers"]
            return self.reply(503, {"error": "no free request workers"}, started,
                              f"no free request workers: {n} of {n} busy")
        with BUSY_LOCK:
            BUSY += 1
        try:
            status, doc, error = work()
        except Exception as e:  # noqa: BLE001
            status, doc, error = 500, {"error": "internal error"}, f"{e.__class__.__name__}: {e}"
        finally:
            with BUSY_LOCK:
                BUSY -= 1
            SLOTS.release()
        self.reply(status, doc, started, error)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/v1/status":
            return self.serve(lambda: (200, {"status": "ok", "workers": CONFIG["workers"], "busy": BUSY}, None))
        m = RE_PROJECT.match(path)
        if not m:
            return self.reply(404, {"error": "not found"}, time.monotonic())
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer ") or len(auth) < 12:
            return self.reply(401, {"error": "a bearer token is required"}, time.monotonic())
        return self.serve(lambda: check_access(int(m.group(1)), auth[7:].strip()))

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        body = self.rfile.read(length) if length > 0 else b""
        m = RE_TOKENS.match(path)
        if not m:
            return self.reply(404, {"error": "not found"}, time.monotonic())
        label = "api"
        try:
            doc = json.loads(body or b"{}")
            if isinstance(doc, dict) and isinstance(doc.get("label"), str) and doc["label"]:
                label = RE_LABEL.sub("-", doc["label"])[:64]
        except ValueError:
            return self.reply(400, {"error": "the body must be JSON"}, time.monotonic())
        return self.serve(lambda: issue_token(int(m.group(1)), label))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128


def main():
    global SLOTS
    CONFIG.update(read_conf())
    SLOTS = threading.BoundedSemaphore(CONFIG["workers"])
    srv = Server((CONFIG["host"], CONFIG["port"]), Handler)
    log(f"listening on {CONFIG['host']}:{CONFIG['port']}, {CONFIG['workers']} request workers, "
        f"token writes: {CONFIG['attempts']} attempts of {CONFIG['attempt_timeout']:g} s each")
    srv.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
