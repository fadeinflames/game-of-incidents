#!/usr/bin/env python3
"""catalog-api: tells a client which translation engines its account may use and forwards translation jobs to them.

GET  /v1/engines       header X-Account: the engines the account is entitled to, with their current status
POST /v1/translate     header X-Account, JSON {"engine": "std", "text": "..."}: the job is forwarded to the engine
GET  /healthz          the process is alive
GET  /internal/config  the settings in effect (after the last start or reload)
GET  /internal/stats   counters since the start

What an account is entitled to is asked from the entitlements service and then reused from memory for
ENTITLEMENT_CACHE_TTL_SEC seconds. A failed lookup is never cached: the next request of the account asks again.

SIGHUP (service catalog-api reload) re-reads the settings file and keeps the cache. A restart starts with an empty one.
"""
import http.client
import json
import re
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

VERSION = "3.14.2"
SETTINGS_FILE = sys.argv[1] if len(sys.argv) > 1 else "/etc/catalog-api/catalog-api.env"
ACCOUNT_RE = re.compile(r"^acc-[0-9]{1,9}$")
ENGINE_NAMES = {"std": "Standard", "pro": "Professional"}
SUMMARY_EVERY_SEC = 10
HEALTH_EVERY_SEC = 5


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} catalog-api: {msg}", flush=True)


class Settings:
    def __init__(self, raw):
        self.listen = raw.get("LISTEN", "127.0.0.1:8080")
        self.entitlements_url = raw.get("ENTITLEMENTS_URL", "http://127.0.0.1:9000").rstrip("/")
        try:
            self.cache_ttl = int(raw.get("ENTITLEMENT_CACHE_TTL_SEC", "2"))
        except ValueError:
            raise ValueError("ENTITLEMENT_CACHE_TTL_SEC must be a whole number of seconds") from None
        if not 0 <= self.cache_ttl <= 86400:
            raise ValueError("ENTITLEMENT_CACHE_TTL_SEC must be between 0 and 86400")
        try:
            self.lookup_timeout = float(raw.get("ENTITLEMENT_LOOKUP_TIMEOUT_SEC", "2.5"))
        except ValueError:
            raise ValueError("ENTITLEMENT_LOOKUP_TIMEOUT_SEC must be a number of seconds") from None
        if not 0.1 <= self.lookup_timeout <= 30:
            raise ValueError("ENTITLEMENT_LOOKUP_TIMEOUT_SEC must be between 0.1 and 30")
        url = urlsplit(self.entitlements_url)
        if url.scheme != "http" or not url.hostname:
            raise ValueError("ENTITLEMENTS_URL must look like http://host:port")
        self.engines = {}
        for item in raw.get("ENGINES", "").split(","):
            name, sep, target = item.strip().partition("=")
            if sep and name and target:
                self.engines[name] = target.rstrip("/")
        if not self.engines:
            raise ValueError("ENGINES must list at least one engine as name=http://host:port")

    def public(self):
        return {
            "version": VERSION,
            "settings_file": SETTINGS_FILE,
            "listen": self.listen,
            "entitlements_url": self.entitlements_url,
            "entitlement_lookup_timeout_sec": self.lookup_timeout,
            "entitlement_cache_ttl_sec": self.cache_ttl,
            "engines": self.engines,
        }


def read_settings():
    raw = {}
    with open(SETTINGS_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            raw[key.strip()] = value.strip().strip('"').strip("'")
    return Settings(raw)


CFG = None
LOCK = threading.Lock()
CACHE = {}  # account -> (time of the lookup, entitlement)
ENGINE_STATUS = {}
STATS = {
    "list_requests": 0,
    "list_errors": 0,
    "translate_requests": 0,
    "entitlement_cache_hits": 0,
    "entitlement_lookups": 0,
    "entitlement_lookup_failures": 0,
}


def bump(key):
    with LOCK:
        STATS[key] += 1


def http_call(base, method, path, timeout, body=None, headers=None):
    """One request to another service. Returns (status, reason, body); status 0 means there was no HTTP answer."""
    url = urlsplit(base)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=dict({"Connection": "close"}, **(headers or {})))
        resp = conn.getresponse()
        return resp.status, resp.reason, resp.read()
    except socket.timeout:
        return 0, f"no answer from {base} in {timeout:g} s", b""
    except (OSError, http.client.HTTPException) as e:
        return 0, f"cannot talk to {base}: {e}", b""
    finally:
        conn.close()


def entitlement(account):
    """-> ("ok", entitlement) | ("denied", None) | ("failed", reason)"""
    cfg = CFG
    now = time.monotonic()
    with LOCK:
        hit = CACHE.get(account)
        if hit and now - hit[0] < cfg.cache_ttl:
            STATS["entitlement_cache_hits"] += 1
            return "ok", hit[1]
        STATS["entitlement_lookups"] += 1
    status, reason, body = http_call(cfg.entitlements_url, "GET", f"/v1/entitlements/{account}", cfg.lookup_timeout,
                                     headers={"X-Caller": "catalog-api"})
    if status == 200:
        try:
            ent = json.loads(body)
            ent["engines"] = [str(e) for e in ent["engines"]]
        except (ValueError, KeyError, TypeError):
            bump("entitlement_lookup_failures")
            return "failed", f"{cfg.entitlements_url} sent an answer that is not an entitlement"
        with LOCK:
            CACHE[account] = (time.monotonic(), ent)
        return "ok", ent
    if status == 404:
        return "denied", None
    bump("entitlement_lookup_failures")
    if status == 0:
        return "failed", reason
    return "failed", f"{cfg.entitlements_url} answered {status} {reason}"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "catalog-api/" + VERSION

    def _send(self, code, doc):
        data = (json.dumps(doc, ensure_ascii=False) + "\n").encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _account(self):
        account = self.headers.get("X-Account", "")
        return account if ACCOUNT_RE.match(account) else None

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._send(200, {"status": "ok", "version": VERSION})
        if path == "/internal/config":
            return self._send(200, CFG.public())
        if path == "/internal/stats":
            with LOCK:
                doc = dict(STATS, entitlement_cache_size=len(CACHE))
            return self._send(200, doc)
        if path == "/v1/engines":
            return self.list_engines()
        self._send(404, {"error": "not_found"})

    def list_engines(self):
        account = self._account()
        if account is None:
            return self._send(401, {"error": "unauthorized", "message": "X-Account is missing or malformed."})
        bump("list_requests")
        state, ent = entitlement(account)
        if state == "failed":
            bump("list_errors")
            log(f"WARN GET /v1/engines account={account}: entitlement lookup failed: {ent}; replied 503 engine_list_unavailable")
            return self._send(503, {"error": "engine_list_unavailable", "message": "Engines are temporarily unavailable. Try again later."})
        if state == "denied":
            return self._send(403, {"error": "not_entitled", "message": "This account has no active subscription."})
        cfg = CFG
        engines = [{"id": e, "name": ENGINE_NAMES.get(e, e), "status": ENGINE_STATUS.get(e, "unknown")}
                   for e in ent["engines"] if e in cfg.engines]
        self._send(200, {"account": account, "plan": ent.get("plan"), "engines": engines})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/v1/translate":
            return self._send(404, {"error": "not_found"})
        account = self._account()
        if account is None:
            return self._send(401, {"error": "unauthorized", "message": "X-Account is missing or malformed."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                raise ValueError("bad length")
            job = json.loads(self.rfile.read(length))
            engine, text = str(job["engine"]), str(job["text"])
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad_request"})
        bump("translate_requests")
        state, ent = entitlement(account)
        if state == "failed":
            log(f"WARN POST /v1/translate account={account}: entitlement lookup failed: {ent}; replied 503 translation_unavailable")
            return self._send(503, {"error": "translation_unavailable", "message": "Translation is temporarily unavailable. Try again later."})
        cfg = CFG
        if state == "denied" or engine not in ent["engines"] or engine not in cfg.engines:
            return self._send(403, {"error": "not_entitled", "message": "This account may not use this engine."})
        status, reason, body = http_call(cfg.engines[engine], "POST", "/translate", 10,
                                         body=json.dumps({"text": text}).encode(), headers={"Content-Type": "application/json"})
        if status != 200:
            log(f"ERROR POST /v1/translate account={account}: engine {engine} failed: {reason if status == 0 else status}")
            return self._send(502, {"error": "engine_failed", "message": "The engine did not complete the job."})
        try:
            return self._send(200, json.loads(body))
        except ValueError:
            return self._send(502, {"error": "engine_failed", "message": "The engine did not complete the job."})

    def log_message(self, *_args):
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


def watch_engines():
    while True:
        cfg = CFG
        for name, base in cfg.engines.items():
            status, reason, _ = http_call(base, "GET", "/healthz", 2)
            state = "ok" if status == 200 else "down"
            if ENGINE_STATUS.get(name) != state:
                if state == "ok":
                    log(f"engine {name} is ok ({base})")
                else:
                    log(f"WARN engine {name} is down ({base}): {reason if status == 0 else status}")
            ENGINE_STATUS[name] = state
        time.sleep(HEALTH_EVERY_SEC)


def summarize():
    last = dict(STATS)
    ticks = 0
    while True:
        time.sleep(SUMMARY_EVERY_SEC)
        ticks += 1
        with LOCK:
            now = dict(STATS)
            if ticks % 6 == 0:
                # entries that can no longer be served are dropped once a minute
                limit = time.monotonic() - CFG.cache_ttl
                for account in [a for a, (t, _) in CACHE.items() if t < limit]:
                    del CACHE[account]
        d = {k: now[k] - last[k] for k in now}
        last = now
        if d["list_requests"]:
            log(f"last {SUMMARY_EVERY_SEC} s: {d['list_requests']} list requests, {d['list_errors']} failed; "
                f"entitlements: {d['entitlement_cache_hits']} answers from cache, {d['entitlement_lookups']} lookups, "
                f"{d['entitlement_lookup_failures']} lookups failed")


def reload_settings(*_args):
    global CFG
    old = CFG
    try:
        new = read_settings()
    except (OSError, ValueError) as e:
        log(f"ERROR reload of {SETTINGS_FILE} failed: {e}; the previous settings stay in effect")
        return
    if new.listen != old.listen:
        log("WARN LISTEN changed: that needs a restart, the old address stays in use")
        new.listen = old.listen
    CFG = new
    with LOCK:
        size = len(CACHE)
    log(f"settings reloaded from {SETTINGS_FILE}: ENTITLEMENT_CACHE_TTL_SEC {old.cache_ttl} -> {new.cache_ttl}, "
        f"ENTITLEMENTS_URL {new.entitlements_url}, lookup timeout {new.lookup_timeout:g} s; cache kept ({size} accounts)")


def main():
    global CFG
    try:
        CFG = read_settings()
    except (OSError, ValueError) as e:
        log(f"FATAL cannot start with {SETTINGS_FILE}: {e}")
        sys.exit(1)
    host, _, port = CFG.listen.partition(":")
    server = Server((host, int(port or 8080)), Handler)
    signal.signal(signal.SIGHUP, reload_settings)
    threading.Thread(target=watch_engines, daemon=True).start()
    threading.Thread(target=summarize, daemon=True).start()
    log(f"version {VERSION} listening on {CFG.listen}; entitlements at {CFG.entitlements_url}, "
        f"ENTITLEMENT_CACHE_TTL_SEC {CFG.cache_ttl}, cache is empty")
    server.serve_forever()


if __name__ == "__main__":
    main()
