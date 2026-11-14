#!/usr/bin/env python3
"""tokend: issues and validates the server-to-server tokens of integrations.

POST /v1/tokens          {"integration": 17} -> 201 {"token": "it_...", "expires_in": 3600}
GET  /v1/tokens/<token>  200 {"integration": 17, ...} | 404 token not found | 401 token expired
GET  /admin/routing      the routing in effect
GET  /health

The install_tokens table is reached through /etc/tokend/routing.conf: one cluster for reads, one for writes.
SIGHUP (service tokend reload) re-reads the routing; a file that does not parse is refused and the old routing stays.
"""
import configparser
import json
import secrets
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql

CONF = "/etc/tokend/tokend.conf"
ROUTING = "/etc/tokend/routing.conf"
TOKEN_TTL_SEC = 3600
routing = {}      # replaced as a whole on reload
settings = {}


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}", flush=True)


def read_routing():
    cp = configparser.ConfigParser()
    with open(ROUTING, encoding="utf-8") as f:
        cp.read_file(f)
    clusters = {}
    for name, addr in cp["clusters"].items():
        host, _, port = addr.strip().partition(":")
        clusters[name] = (host, int(port))
    reads = cp["install_tokens"]["reads"].strip()
    writes = cp["install_tokens"]["writes"].strip()
    for role, name in (("reads", reads), ("writes", writes)):
        if name not in clusters:
            raise ValueError(f"{role} = {name}: no such cluster in [clusters]")
    return {"clusters": clusters, "reads": reads, "writes": writes}


def reload_routing(*_args):
    global routing
    try:
        new = read_routing()
    except Exception as e:  # noqa: BLE001
        log(f"tokend: routing NOT reloaded, {ROUTING} is refused: {e}")
        return
    routing = new
    log(f"tokend: routing loaded: install_tokens reads={new['reads']} writes={new['writes']}")


def db(cluster):
    host, port = routing["clusters"][cluster]
    return pymysql.connect(host=host, port=port, user=settings["user"], password=settings["password"],
                           database=settings["name"], connect_timeout=3, read_timeout=10, write_timeout=10, charset="utf8mb4")


def age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 120:
        return f"{seconds}s"
    if seconds < 7200:
        return f"{seconds // 60}m"
    if seconds < 172800:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def _send(self, code, body):
        data = (json.dumps(body, ensure_ascii=False) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _access(self, code, detail, cluster, started):
        log(f"{self.command} {self.path.split('?')[0]} {code} {detail} db={cluster} {int((time.monotonic() - started) * 1000)}ms")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            return self._send(200, {"ok": True})
        if path == "/admin/routing":
            return self._send(200, {"install_tokens": {"reads": routing["reads"], "writes": routing["writes"]}})
        if not path.startswith("/v1/tokens/"):
            return self._send(404, {"error": "not found"})
        token = path[len("/v1/tokens/"):]
        started = time.monotonic()
        cluster = routing["reads"]
        try:
            conn = db(cluster)
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT integration_id, created_at, expires_at, expires_at > NOW(), TIMESTAMPDIFF(SECOND, created_at, NOW()) "
                                "FROM install_tokens WHERE token = %s", (token,))
                    row = cur.fetchone()
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            self._access(503, f"database_error ({e})", cluster, started)
            return self._send(503, {"error": "database unavailable"})
        if row is None:
            self._access(404, "not_found", cluster, started)
            return self._send(404, {"error": "token not found"})
        if not row[3]:
            self._access(401, f"expired integration={row[0]}", cluster, started)
            return self._send(401, {"error": "token expired"})
        self._access(200, f"ok integration={row[0]} age={age(row[4])}", cluster, started)
        self._send(200, {"integration": row[0], "created_at": str(row[1]), "expires_at": str(row[2])})

    def do_POST(self):
        if self.path.split("?")[0] != "/v1/tokens":
            return self._send(404, {"error": "not found"})
        try:
            doc = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            integration = int(doc["integration"])
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad request"})
        started = time.monotonic()
        cluster = routing["writes"]
        token = "it_" + secrets.token_hex(12)
        try:
            conn = db(cluster)
            try:
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO install_tokens (token, integration_id, created_at, expires_at) "
                                "VALUES (%s, %s, NOW(), NOW() + INTERVAL %s SECOND)", (token, integration, TOKEN_TTL_SEC))
                conn.commit()
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            self._access(503, f"database_error ({e})", cluster, started)
            return self._send(503, {"error": "database unavailable"})
        self._access(201, f"token={token} integration={integration}", cluster, started)
        self._send(201, {"token": token, "expires_in": TOKEN_TTL_SEC})

    def log_message(self, *_args):
        pass


def main():
    cp = configparser.ConfigParser()
    with open(CONF, encoding="utf-8") as f:
        cp.read_file(f)
    settings.update(name=cp["database"]["name"], user=cp["database"]["user"], password=cp["database"]["password"])
    host, _, port = cp["listen"]["address"].partition(":")
    try:
        routing.update(read_routing())
    except Exception as e:  # noqa: BLE001
        log(f"tokend: cannot start, {ROUTING} is refused: {e}")
        return 1
    signal.signal(signal.SIGHUP, reload_routing)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    log(f"tokend: listening on {host}:{port}")
    log(f"tokend: routing loaded: install_tokens reads={routing['reads']} writes={routing['writes']}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
