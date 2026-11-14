#!/usr/bin/env python3
"""settingsd: serves the settings of the services of this host over HTTP.

Every service has a namespace. The keys a namespace may hold, their types and built-in defaults are listed in
/opt/settingsd/schema.json; the values come from /etc/settingsd/namespaces/<namespace>.toml.

  GET /v1/settings/<namespace>   ->  {"namespace": "...", "values": {"key": value, ...}}
  GET /healthz

The files are read at start and on SIGHUP (service settingsd reload). A namespace whose file cannot be loaded is
served from the built-in defaults.
"""
import json
import os
import signal
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.6.0"
SCHEMA = "/opt/settingsd/schema.json"
NS_DIR = "/etc/settingsd/namespaces"
LISTEN = ("127.0.0.1", 8500)

values = {}
reload_requested = threading.Event()
stopping = threading.Event()


def log(level, msg):
    print("%s %s %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), level, msg), flush=True)


def flatten(table, prefix=""):
    out = {}
    for key, value in table.items():
        if isinstance(value, dict):
            out.update(flatten(value, prefix + key + "."))
        else:
            out[prefix + key] = value
    return out


def checked(spec, key, value):
    kind = spec["type"]
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError("%s: expected true or false, got %r" % (key, value))
    elif kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("%s: expected an integer, got %r" % (key, value))
        if "min" in spec and value < spec["min"]:
            raise ValueError("%s: %d is below the minimum %d" % (key, value, spec["min"]))
        if "max" in spec and value > spec["max"]:
            raise ValueError("%s: %d is above the maximum %d" % (key, value, spec["max"]))
    return value


def load_namespace(name, spec):
    defaults = {key: item["default"] for key, item in spec.items()}
    path = os.path.join(NS_DIR, name + ".toml")
    if not os.path.exists(path):
        log("INFO", "namespace %s: no file %s, built-in defaults" % (name, path))
        return defaults
    try:
        with open(path, "rb") as fh:
            data = flatten(tomllib.load(fh))
        loaded = dict(defaults)
        count = 0
        for key, value in data.items():
            if key not in spec:
                raise ValueError("%s: unknown key" % key)
            loaded[key] = checked(spec[key], key, value)
            count += 1
    except (OSError, tomllib.TOMLDecodeError, ValueError) as exc:
        log("WARN", "namespace %s: %s not loaded (%s); serving built-in defaults" % (name, path, exc))
        return defaults
    log("INFO", "namespace %s: %d values from %s" % (name, count, path))
    return loaded


def load_all():
    global values
    with open(SCHEMA, encoding="utf-8") as fh:
        schema = json.load(fh)
    values = {name: load_namespace(name, spec) for name, spec in sorted(schema.items())}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

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
            return self.reply(200, {"status": "ok", "namespaces": sorted(values)})
        if path.startswith("/v1/settings/"):
            name = path[len("/v1/settings/"):]
            current = values.get(name)
            if current is None:
                return self.reply(404, {"error": "unknown namespace"})
            return self.reply(200, {"namespace": name, "values": current})
        self.reply(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def main():
    log("INFO", "settingsd %s starting, schema %s" % (VERSION, SCHEMA))
    load_all()
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log("INFO", "listening on %s:%d" % LISTEN)
    signal.signal(signal.SIGHUP, lambda *_: reload_requested.set())
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    while not stopping.is_set():
        if reload_requested.is_set():
            reload_requested.clear()
            log("INFO", "reload requested (SIGHUP)")
            try:
                load_all()
            except Exception as exc:
                log("ERROR", "reload failed, the previous values stay: %s" % exc)
        time.sleep(0.2)
    log("INFO", "settingsd stopped")


if __name__ == "__main__":
    main()
