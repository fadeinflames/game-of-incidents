#!/usr/bin/env python3
"""order-service: POST /orders -> BEGIN; INSERT order; call payment-proxy; COMMIT.
Bounded worker pool (WORKERS): when every worker is stuck, /health waits too and the liveness probe fails.
PAYMENT_TIMEOUT empty => no timeout (the bug)."""
import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer

import pg8000.native

DB = dict(
    host=os.environ.get("PGHOST", "postgres"),
    user=os.environ.get("PGUSER", "orders"),
    password=os.environ.get("PGPASSWORD", "orders"),
    database=os.environ.get("PGDATABASE", "orders"),
    timeout=5,
)
PAYMENT_URL = os.environ.get("PAYMENT_URL", "http://payment-proxy:8081/charge")
_t = os.environ.get("PAYMENT_TIMEOUT", "").strip()
PAYMENT_TIMEOUT = float(_t) if _t else None
WORKERS = int(os.environ.get("WORKERS", "6"))
CARD_ENABLED = os.environ.get("PAYMENTS_CARD_ENABLED", "true").lower() == "true"
ASYNC_PAYMENT = os.environ.get("ORDERS_ASYNC_PAYMENT", "false").lower() == "true"

stats = {"orders": 0, "errors": 0, "inflight": 0}
lock = threading.Lock()


def log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} order-service: {msg}\n")


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
            self._send(200, {"ok": True, "inflight": stats["inflight"]})
        elif self.path == "/stats":
            self._send(200, stats)
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/orders":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            payload = {}
        method = payload.get("method", "card")
        amount = float(payload.get("amount", 990))
        with lock:
            stats["inflight"] += 1
        conn = None
        try:
            conn = pg8000.native.Connection(**DB)
            conn.run("BEGIN")
            (oid,) = conn.run("INSERT INTO orders (amount, method, status) VALUES (:a, :m, 'pending') RETURNING id", a=amount, m=method)[0]
            if method == "card":
                if not CARD_ENABLED:
                    conn.run("UPDATE orders SET status='rejected' WHERE id=:i", i=oid)
                    conn.run("COMMIT")
                    self._send(503, {"error": "card payments temporarily disabled", "order": oid})
                    return
                if not ASYNC_PAYMENT:
                    req = urllib.request.Request(PAYMENT_URL, data=json.dumps({"order": oid, "amount": amount}).encode(), headers={"Content-Type": "application/json"})
                    # the bug: this blocks INSIDE the open transaction, possibly forever
                    with urllib.request.urlopen(req, timeout=PAYMENT_TIMEOUT) as r:
                        res = json.loads(r.read() or b"{}")
                    if res.get("status") != "approved":
                        raise RuntimeError(f"payment declined: {res}")
                    conn.run("UPDATE orders SET status='paid' WHERE id=:i", i=oid)
                else:
                    conn.run("UPDATE orders SET status='pending_async' WHERE id=:i", i=oid)
            else:  # sbp
                conn.run("UPDATE orders SET status='paid' WHERE id=:i", i=oid)
            conn.run("COMMIT")
            with lock:
                stats["orders"] += 1
            self._send(201, {"order": oid, "status": "accepted"})
        except Exception as e:  # noqa: BLE001
            with lock:
                stats["errors"] += 1
            log(f"order failed: {e!r}")
            try:
                if conn:
                    conn.run("ROLLBACK")
            except Exception:  # noqa: BLE001
                pass
            self._send(502, {"error": str(e)[:200]})
        finally:
            with lock:
                stats["inflight"] -= 1
            if conn:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass

    def log_message(self, fmt, *args):  # noqa: N802
        pass


class PooledServer(HTTPServer):
    """Bounded worker pool: like a Java app server with maxThreads. Extra requests queue up (and time out at the edge)."""

    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.pool = ThreadPoolExecutor(max_workers=WORKERS)

    def process_request(self, request, client_address):
        self.pool.submit(self.process_request_thread, request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:  # noqa: BLE001
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod.
    # os._exit: a normal exit would first wait for the busy (stuck) pool workers
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    log(f"starting with WORKERS={WORKERS} PAYMENT_TIMEOUT={PAYMENT_TIMEOUT} card_enabled={CARD_ENABLED} async={ASYNC_PAYMENT}")
    PooledServer(("0.0.0.0", 8080), Handler).serve_forever()
