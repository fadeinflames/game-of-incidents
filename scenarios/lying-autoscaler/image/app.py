#!/usr/bin/env python3
"""checkout-api. GET /health, GET /checkout -> ok. With PEER_GOSSIP=on every replica syncs its in-flight table with
every other replica once a second (release 3.4: "cart consistency across pods"). The sync costs CPU per peer, so the
CPU per pod grows with the number of pods: the HPA on CPU sees more load the more it scales."""
import hashlib
import os
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

GOSSIP = os.environ.get("PEER_GOSSIP", "off") == "on"
PEERS_DNS = os.environ.get("PEERS_DNS", "checkout-api-peers")
PER_PEER_MS = int(os.environ.get("GOSSIP_COST_MS", "40"))


def log(level, msg):
    sys.stderr.write(f"[{level}] {msg}\n")
    sys.stderr.flush()


def burn(ms):
    end = time.perf_counter() + ms / 1000.0
    h = b"x"
    while time.perf_counter() < end:
        h = hashlib.sha256(h).digest()


def gossip():
    while True:
        try:
            peers = sorted({a[4][0] for a in socket.getaddrinfo(PEERS_DNS, 8080, socket.AF_INET)})
        except OSError:
            peers = []
        for _ in peers:
            burn(PER_PEER_MS)  # "merge in-flight table from peer"
        if int(time.time()) % 30 == 0:
            log("INFO", f"gossip: synced with {len(peers)} peers")
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, "ok\n")
        burn(2)
        self._send(200, f"checkout ok ({os.environ.get('HOSTNAME', '?')})\n")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", f"checkout-api 3.4 starting, peer gossip: {'on' if GOSSIP else 'off'}")
    if GOSSIP:
        threading.Thread(target=gossip, daemon=True).start()
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
