#!/usr/bin/env python3
"""access-api: answers the gateways whether a customer may use the paid feature right now.

  GET /v1/access/<customer>  ->  {"customer": 1017, "allowed": true|false, "reason": "ok"|"budget_exhausted",
                                  "spent_cents": ..., "limit_cents": ..., "as_of": "...", "source": "...",
                                  "cache": "hit"|"miss"|"unavailable"}
  GET /healthz

The answer is the cached access status (Redis, access:<customer>) when there is one. Without a cached status the API
computes it from the budget data in PostgreSQL (spent this period < monthly limit) and caches the result.
"""
import configparser
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg2
import redis

CONF = "/etc/access-api/api.conf"
DEFAULT_TTL = 21600


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(level, msg):
    print("%s %s %s" % (stamp(), level, msg), flush=True)


class Backend:
    def __init__(self, conf):
        self.dsn = conf.get("database", "dsn")
        self.redis = redis.Redis(host=conf.get("redis", "host", fallback="127.0.0.1"),
                                 port=conf.getint("redis", "port", fallback=6379),
                                 socket_timeout=2, socket_connect_timeout=2, decode_responses=True)
        self.db = None
        self.db_lock = threading.Lock()
        self.ttl = DEFAULT_TTL
        url = "%s/v1/settings/%s" % (conf.get("settings", "url", fallback="http://127.0.0.1:8500").rstrip("/"),
                                     conf.get("settings", "namespace", fallback="access-api"))
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                self.ttl = int(json.load(resp)["values"]["cache.status_ttl_sec"])
            log("INFO", "settings (%s): cache.status_ttl_sec=%d" % (url, self.ttl))
        except Exception as exc:
            log("WARN", "settings service %s is unavailable (%s): cache.status_ttl_sec=%d (built-in default)" % (url, exc, self.ttl))

    def budget(self, customer):
        """(limit_cents, spent_cents) from PostgreSQL, None for an unknown customer."""
        sql = ("SELECT b.limit_cents, u.spent_cents FROM budgets b JOIN usage_current u USING (customer_id) "
               "WHERE b.customer_id = %s")
        with self.db_lock:
            for attempt in (1, 2):
                try:
                    if self.db is None or self.db.closed:
                        self.db = psycopg2.connect(self.dsn)
                        self.db.autocommit = True
                    cur = self.db.cursor()
                    cur.execute(sql, (customer,))
                    return cur.fetchone()
                except psycopg2.Error:
                    try:
                        if self.db is not None:
                            self.db.close()
                    except Exception:
                        pass
                    self.db = None
                    if attempt == 2:
                        raise

    def access(self, customer):
        key = "access:%d" % customer
        cache = "miss"
        status = None
        try:
            raw = self.redis.get(key)
            if raw is not None:
                status = json.loads(raw)
                cache = "hit"
        except redis.RedisError:
            cache = "unavailable"
        except ValueError:
            status = None
        if status is None:
            row = self.budget(customer)
            if row is None:
                return None
            limit, spent = row
            allowed = spent < limit
            status = {"allowed": allowed, "reason": "ok" if allowed else "budget_exhausted", "spent_cents": spent,
                      "limit_cents": limit, "as_of": stamp(), "source": "access-api"}
            if cache == "miss":
                try:
                    self.redis.set(key, json.dumps(status), ex=self.ttl)
                except redis.RedisError:
                    cache = "unavailable"
        try:
            self.redis.hincrby("stats:access:" + time.strftime("%Y%m%d", time.gmtime()),
                               "allowed" if status.get("allowed") else "blocked", 1)
        except redis.RedisError:
            pass
        answer = {"customer": customer}
        answer.update(status)
        answer["cache"] = cache
        return answer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    backend = None

    def reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if path == "/healthz":
            return self.reply(200, {"status": "ok"})
        if not path.startswith("/v1/access/"):
            return self.reply(404, {"error": "not found"})
        try:
            customer = int(path[len("/v1/access/"):])
        except ValueError:
            return self.reply(400, {"error": "customer id must be a number"})
        try:
            answer = self.backend.access(customer)
        except psycopg2.Error as exc:
            log("ERROR", "GET %s -> 503, database: %s" % (path, str(exc).strip().splitlines()[0] if str(exc).strip() else "error"))
            return self.reply(503, {"error": "budget data unavailable"})
        if answer is None:
            log("INFO", "GET %s -> 404 unknown customer" % path)
            return self.reply(404, {"error": "unknown customer"})
        log("INFO", "GET %s -> %s (cache %s, as of %s)" % (
            path, "allowed" if answer.get("allowed") else "blocked", answer["cache"], answer.get("as_of", "?")))
        self.reply(200, answer)

    def log_message(self, fmt, *args):
        pass


def main():
    conf = configparser.ConfigParser()
    conf.read(CONF)
    Handler.backend = Backend(conf)
    address = (conf.get("api", "listen_host", fallback="127.0.0.1"), conf.getint("api", "listen_port", fallback=8080))
    server = ThreadingHTTPServer(address, Handler)
    server.daemon_threads = True
    log("INFO", "access-api listening on %s:%d" % address)
    server.serve_forever()


if __name__ == "__main__":
    main()
