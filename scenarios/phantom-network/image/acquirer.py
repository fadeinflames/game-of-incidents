#!/usr/bin/env python3
"""Acquirer stub. UPSTREAM_PROFILE=normal: answers 200 approved. UPSTREAM_PROFILE=degraded: accepts the connection, reads
the request and never answers (no FIN, no RST) -- the 'black hole' behaviour of the real incident. The profile is not
logged on purpose: like a real third party, the acquirer does not announce that it is broken."""
import json
import os
import signal
import socket
import sys
import threading
import time

PROFILE = os.environ.get("UPSTREAM_PROFILE", "normal")
NAME = os.environ.get("ACQUIRER_NAME", "A")
PORT = int(os.environ.get("PORT", "8443"))


def handle(conn):
    try:
        conn.settimeout(30)
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                return
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1].strip())
        while len(rest) < length:
            chunk = conn.recv(4096)
            if not chunk:
                break
            rest += chunk
        if PROFILE == "degraded":
            time.sleep(3600)  # silence
            return
        body = json.dumps({"status": "approved", "acquirer": NAME, "auth_code": "A1B2C3"}).encode()
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write(f"acquirer {NAME}: listening on port {PORT}\n")
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", PORT))
    s.listen(512)
    while True:
        c, _ = s.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()
