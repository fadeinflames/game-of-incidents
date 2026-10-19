#!/usr/bin/env python3
"""metrics-gateway: the central observability endpoint. HTTPS :9443 accepts Prometheus remote_write
(POST /api/v1/write, body ignored, 204). Plain HTTP :9090 /status reports the age of the last write.
The server certificate is issued by the CA selected with CA_ACTIVE (1 or 2), see /certs."""
import json
import os
import signal
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer

CA = os.environ.get("CA_ACTIVE", "1")
# the handshake runs in the accept loop: a connection that never speaks must not hold up the next client
HANDSHAKE_TIMEOUT_S = 5
state = {"last_write": None, "writes": 0, "tls_errors": 0}


def log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} gateway: {msg}\n")
    sys.stderr.flush()


class Write(BaseHTTPRequestHandler):
    timeout = 30  # a client that stalls after the handshake only costs its own thread for this long

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        if self.path == "/api/v1/write":
            state["last_write"] = time.time()
            state["writes"] += 1
            self.send_response(204)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):  # noqa: N802
        pass


class Status(BaseHTTPRequestHandler):
    def do_GET(self):
        age = None if state["last_write"] is None else int(time.time() - state["last_write"])
        body = json.dumps({"ca_active": CA, "writes": state["writes"], "last_write_age_s": age, "tls_handshake_errors": state["tls_errors"]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        pass


class TLSServer(ThreadingHTTPServer):
    """TLS is negotiated per connection in get_request so that a failed handshake (client rejects our certificate) is counted"""

    ctx = None

    def get_request(self):
        sock, addr = self.socket.accept()
        try:
            sock.settimeout(HANDSHAKE_TIMEOUT_S)
            return self.ctx.wrap_socket(sock, server_side=True), addr
        except (ssl.SSLError, OSError) as e:
            state["tls_errors"] += 1
            if state["tls_errors"] % 10 == 1:
                log(f"TLS handshake failed from {addr[0]}: {getattr(e, 'reason', e)} (client rejected our certificate? total {state['tls_errors']})")
            sock.close()
            raise OSError("tls handshake failed") from None


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(f"/certs/ca{CA}/server.crt", f"/certs/ca{CA}/server.key")
    TLSServer.ctx = ctx
    srv = TLSServer(("0.0.0.0", 9443), Write)
    log(f"remote_write endpoint on :9443, certificate issued by CA #{CA}")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    HTTPServer(("0.0.0.0", 9090), Status).serve_forever()
