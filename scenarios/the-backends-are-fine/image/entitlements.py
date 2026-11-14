#!/usr/bin/env python3
"""entitlements: the billing team's service that knows what every account has paid for.

GET /v1/entitlements/<account>  -> {"account", "plan", "engines"}; 404 if the account has no active subscription
GET /healthz                    -> the state of the service and how many lookups are waiting
GET /stats                      -> counters since the start

Every lookup is one query to the subscriptions database over the service's single connection, about 100 ms each, so the
service can answer about ten lookups per second. Lookups queue for the connection; one that has waited 1.5 s is refused
with 503. The gateway in front of the service keeps every consumer well below that.
"""
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = ("127.0.0.1", 9100)
DB_QUERY_SEC = 0.1
MAX_WAIT_SEC = 1.5
ACCOUNT_RE = re.compile(r"^/v1/entitlements/acc-([0-9]{1,9})$")

DB = threading.Lock()  # the one database connection
LOCK = threading.Lock()
STATS = {"lookups_total": 0, "served_total": 0, "refused_total": 0, "direct_total": 0, "waiting": 0}


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} entitlements: {msg}", flush=True)


def subscription(number):
    """The stand-in for the subscriptions table: accounts below 100 are closed, every fourth account is on the solo plan."""
    if number < 100:
        return None
    if number % 4 == 0:
        return {"plan": "solo", "engines": ["std"]}
    return {"plan": "team", "engines": ["std", "pro"]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "entitlements/1.8"

    def _send(self, code, doc):
        data = (json.dumps(doc) + "\n").encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            with LOCK:
                waiting = STATS["waiting"]
            return self._send(200, {"status": "ok" if waiting < 10 else "overloaded", "database": "ok", "lookups_waiting": waiting})
        if path == "/stats":
            with LOCK:
                return self._send(200, dict(STATS))
        m = ACCOUNT_RE.match(path)
        if not m:
            return self._send(404, {"error": "not_found"})
        account = "acc-" + m.group(1)
        via = self.headers.get("X-Gateway") or "direct"
        caller = self.headers.get("X-Caller") or "-"
        t0 = time.monotonic()
        with LOCK:
            STATS["lookups_total"] += 1
            STATS["waiting"] += 1
            if via == "direct":
                STATS["direct_total"] += 1
        got = DB.acquire(timeout=MAX_WAIT_SEC)
        waited = int((time.monotonic() - t0) * 1000)
        if not got:
            with LOCK:
                STATS["waiting"] -= 1
                STATS["refused_total"] += 1
                waiting = STATS["waiting"]
            log(f"WARN lookup {account} refused with 503: waited {waited} ms for the database connection, {waiting} more lookups are waiting (caller={caller} via={via})")
            return self._send(503, {"error": "overloaded", "message": "The lookup queue is full."})
        try:
            time.sleep(DB_QUERY_SEC)
            sub = subscription(int(m.group(1)))
        finally:
            DB.release()
        with LOCK:
            STATS["waiting"] -= 1
            STATS["served_total"] += 1
        if sub is None:
            log(f"lookup {account} -> 404 no active subscription, waited {waited} ms (caller={caller} via={via})")
            return self._send(404, {"error": "no_active_subscription", "account": account})
        log(f"lookup {account} -> 200 plan={sub['plan']}, waited {waited} ms (caller={caller} via={via})")
        self._send(200, dict(sub, account=account))

    def log_message(self, *_args):
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


def main():
    server = Server(LISTEN, Handler)
    log(f"listening on {LISTEN[0]}:{LISTEN[1]}, one database connection, a lookup waits at most {MAX_WAIT_SEC:g} s")
    server.serve_forever()


if __name__ == "__main__":
    main()
