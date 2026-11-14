#!/usr/bin/env python3
"""customers (stand): the servers of the customers, all in one process. Accepts every delivery with 200 and remembers
what it has received. In real life nobody can ask the customers' servers what they got; on the stand this replaces
the tickets the customers would write.

POST /hooks/<hook>            a delivery (headers X-Delivery-Id, X-Event)
GET  /stats                   totals
GET  /received?hook=&limit=   what has been received, newest first
"""
import hashlib
import hmac
import json
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# the audit listing (with body hashes) is for the stand's own checks; only the hash of its token is kept here
AUDIT_TOKEN_SHA256 = "f0ab11faa07b90e16cf5ee2f6e3750a8263c227f52a60d951c90f83259ca66d6"

started = time.time()
lock = threading.Lock()
received = {}  # delivery id -> [times received, sha256 of the first body, hook, event, first time, bodies differed]
order = []     # delivery ids in the order of the first arrival
requests_total = 0


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        global requests_total
        parts = [p for p in urlsplit(self.path).path.split("/") if p]
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        delivery_id = self.headers.get("X-Delivery-Id", "")
        if len(parts) != 2 or parts[0] != "hooks" or not delivery_id or len(delivery_id) > 100 or "\t" in delivery_id:
            self._send(400, {"error": "expected POST /hooks/<hook> with the header X-Delivery-Id"})
            return
        digest = hashlib.sha256(body).hexdigest()
        with lock:
            requests_total += 1
            entry = received.get(delivery_id)
            if entry is None:
                hook = "".join(c for c in parts[1][:64] if c.isalnum() or c in "-_.")
                received[delivery_id] = [1, digest, hook, self.headers.get("X-Event", "")[:64], time.time(), False]
                order.append(delivery_id)
            else:
                entry[0] += 1
                if entry[1] != digest:
                    entry[5] = True
        self._send(200, {"ok": True})

    def do_GET(self):  # noqa: N802
        url = urlsplit(self.path)
        qs = parse_qs(url.query)
        if url.path == "/healthz":
            self._send(200, {"ok": True})
        elif url.path == "/stats":
            with lock:
                repeated = sum(1 for e in received.values() if e[0] > 1)
                body = {
                    "deliveries_received": len(received),
                    "requests_total": requests_total,
                    "deliveries_received_more_than_once": repeated,
                    "uptime_sec": int(time.time() - started),
                }
            self._send(200, body)
        elif url.path == "/received":
            hook = qs.get("hook", [None])[0]
            try:
                limit = max(1, min(int(qs.get("limit", ["20"])[0]), 1000))
            except ValueError:
                limit = 20
            out = []
            with lock:
                for delivery_id in reversed(order):
                    e = received[delivery_id]
                    if hook is not None and e[2] != hook:
                        continue
                    out.append({
                        "delivery_id": delivery_id,
                        "hook": e[2],
                        "event": e[3],
                        "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e[4])),
                        "times_received": e[0],
                    })
                    if len(out) >= limit:
                        break
            self._send(200, {"hook": hook, "deliveries": out})
        elif url.path == "/audit":
            token = self.headers.get("X-Audit-Token", "")
            if not hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), AUDIT_TOKEN_SHA256):
                self._send(403, {"error": "forbidden"})
                return
            with lock:
                lines = ["#audit\t%d\t%d\t%d" % (len(order), requests_total, int(started))]
                for delivery_id in order:
                    e = received[delivery_id]
                    lines.append("%s\t%s\t%d\t%s\t%d" % (delivery_id, e[1], e[0], e[2], 1 if e[5] else 0))
                lines.append("#end")
            self._send(200, ("\n".join(lines) + "\n").encode(), "text/plain")
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def report():
    last = 0
    while True:
        time.sleep(30)
        with lock:
            now = requests_total
        sys.stdout.write("%s INFO  30 s: %d deliveries accepted with 200\n" % (time.strftime("%H:%M:%S"), now - last))
        sys.stdout.flush()
        last = now


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    threading.Thread(target=report, daemon=True).start()
    sys.stdout.write("%s INFO  customers starting on :8080: every delivery is accepted with 200\n" % time.strftime("%H:%M:%S"))
    sys.stdout.flush()
    server.serve_forever()
