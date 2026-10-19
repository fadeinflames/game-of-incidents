#!/usr/bin/env python3
"""payment-proxy: POST /charge -> acquirer A (primary), optionally acquirer B (fallback).
ACQUIRER_TIMEOUT empty => no timeout (the bug). Stays 'green': /health always 200, no errors while requests hang.
/metrics exposes how many upstream calls are in flight per acquirer."""
import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACQ_A = os.environ.get("ACQUIRER_A_URL", "http://acquirer-a:8443/authorize")
ACQ_B = os.environ.get("ACQUIRER_B_URL", "http://acquirer-b:8443/authorize")
_t = os.environ.get("ACQUIRER_TIMEOUT", "").strip()
TIMEOUT = float(_t) if _t else None
FALLBACK = os.environ.get("FALLBACK_ACQUIRER", "false").lower() == "true"

inflight = {"a": 0, "b": 0}
started = {}  # call id -> (acquirer, monotonic start): /metrics counts calls STUCK for > STUCK_AFTER seconds
STUCK_AFTER = 10.0
_seq = 0
totals = {"approved": 0, "failed": 0, "fallback": 0}
lock = threading.Lock()


def log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} payment-proxy: {msg}\n")


def call(acq, url, body):
    global _seq
    with lock:
        inflight[acq] += 1
        _seq += 1
        cid = _seq
        started[cid] = (acq, time.monotonic())
    try:
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:  # TIMEOUT=None -> waits forever
            return json.loads(r.read() or b"{}")
    finally:
        with lock:
            inflight[acq] -= 1
            started.pop(cid, None)


def stuck(acq):
    now = time.monotonic()
    return sum(1 for a, t0 in started.values() if a == acq and now - t0 > STUCK_AFTER)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = (json.dumps(body) if ctype == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        elif self.path == "/metrics":
            with lock:
                text = (
                    f'payment_proxy_inflight_upstream{{acquirer="a"}} {inflight["a"]}\n'
                    f'payment_proxy_inflight_upstream{{acquirer="b"}} {inflight["b"]}\n'
                    f'payment_proxy_upstream_stuck{{acquirer="a"}} {stuck("a")}\n'
                    f'payment_proxy_upstream_stuck{{acquirer="b"}} {stuck("b")}\n'
                    f'payment_proxy_charges_total{{result="approved"}} {totals["approved"]}\n'
                    f'payment_proxy_charges_total{{result="failed"}} {totals["failed"]}\n'
                    f'payment_proxy_charges_total{{result="fallback"}} {totals["fallback"]}\n'
                    f"payment_proxy_acquirer_timeout_seconds {TIMEOUT if TIMEOUT is not None else 0}\n"
                )
            self._send(200, text, "text/plain")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/charge":
            self._send(404, {"error": "not found"})
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            res = call("a", ACQ_A, body)
        except Exception as e:  # noqa: BLE001
            if FALLBACK:
                try:
                    res = call("b", ACQ_B, body)
                    with lock:
                        totals["fallback"] += 1
                except Exception as e2:  # noqa: BLE001
                    with lock:
                        totals["failed"] += 1
                    self._send(502, {"status": "failed", "error": f"A: {e!r}; B: {e2!r}"[:300]})
                    return
            else:
                with lock:
                    totals["failed"] += 1
                self._send(502, {"status": "failed", "error": repr(e)[:300]})
                return
        with lock:
            totals["approved"] += 1
        self._send(200, res)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log(f"starting ACQUIRER_TIMEOUT={TIMEOUT} FALLBACK_ACQUIRER={FALLBACK}")
    ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
