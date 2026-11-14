#!/usr/bin/env python3
"""history-api: what the customer sees in the dashboard. Reads the deliveries store, never writes to it.

GET  /hooks/<hook>/deliveries?limit=20   the latest deliveries of a hook and their total number
GET  /deliveries/<delivery id>           one delivery
POST /deliveries/<delivery id>/redeliver redelivery; only the owner of the hook may ask for it
GET  /stats                              totals over the whole store
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import common

log = common.setup("history-api")

COLUMNS = ("delivery_id", "hook_id", "event", "status", "duration_ms", "delivered_at", "recorded_at")
SELECT = "SELECT delivery_id, hook_id, event, status, duration_ms, delivered_at, recorded_at FROM deliveries"


def as_json(row):
    d = dict(zip(COLUMNS, row))
    for k in ("delivered_at", "recorded_at"):
        d[k] = d[k].isoformat(timespec="milliseconds") if d[k] is not None else None
    return d


def query(sql, **params):
    conn = common.pg_connect()
    try:
        return conn.run(sql, **params)
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "history-api/%s" % common.RELEASE

    def _send(self, code, body):
        data = (json.dumps(body, ensure_ascii=False) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self, method):
        url = urlsplit(self.path)
        parts = [p for p in url.path.split("/") if p]
        qs = parse_qs(url.query)
        if method == "GET" and parts == ["healthz"]:
            return 200, {"ok": True}
        if method == "GET" and parts == ["version"]:
            return 200, {"component": "history-api", "release": common.RELEASE}
        if method == "GET" and parts == ["stats"]:
            total, hooks, last = query("SELECT count(*), count(DISTINCT hook_id), max(delivered_at) FROM deliveries")[0]
            return 200, {"deliveries_total": total, "hooks": hooks, "last_delivered_at": last.isoformat(timespec="milliseconds") if last else None}
        if method == "GET" and len(parts) == 3 and parts[0] == "hooks" and parts[2] == "deliveries":
            try:
                limit = max(1, min(int(qs.get("limit", ["20"])[0]), 500))
            except ValueError:
                return 400, {"error": "limit must be a number"}
            rows = query(SELECT + " WHERE hook_id = :hook ORDER BY delivered_at DESC LIMIT :n", hook=parts[1], n=limit)
            total = query("SELECT count(*) FROM deliveries WHERE hook_id = :hook", hook=parts[1])[0][0]
            return 200, {"hook": parts[1], "total": total, "deliveries": [as_json(r) for r in rows]}
        if method == "GET" and len(parts) == 2 and parts[0] == "deliveries":
            rows = query(SELECT + " WHERE delivery_id = :id", id=parts[1])
            if not rows:
                return 404, {"error": "delivery not found", "delivery_id": parts[1]}
            return 200, as_json(rows[0])
        if method == "POST" and len(parts) == 3 and parts[0] == "deliveries" and parts[2] == "redeliver":
            rows = query(SELECT + " WHERE delivery_id = :id", id=parts[1])
            if not rows:
                return 404, {"error": "delivery not found: there is nothing to redeliver", "delivery_id": parts[1]}
            return 403, {"error": "a redelivery is requested by the owner of the hook (customer token required)", "delivery_id": parts[1]}
        return 404, {"error": "not found"}

    def _handle(self, method):
        t0 = time.monotonic()
        try:
            code, body = self._route(method)
        except Exception as e:  # noqa: BLE001
            log.warning("%s %s: the deliveries store is not available: %r", method, self.path, e)
            code, body = 503, {"error": "the deliveries store is not available"}
        self._send(code, body)
        log.debug("%s %s -> %d in %d ms", method, self.path, code, (time.monotonic() - t0) * 1000)

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self._handle("POST")

    def log_message(self, fmt, *args):
        pass


def main():
    log.info("history-api %s starting on :8080, reads table deliveries", common.RELEASE)
    ThreadingHTTPServer.daemon_threads = True
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    common.stopping.wait()
    server.shutdown()
    log.info("history-api %s stopped", common.RELEASE)


if __name__ == "__main__":
    main()
