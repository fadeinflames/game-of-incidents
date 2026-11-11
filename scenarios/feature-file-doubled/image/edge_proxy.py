#!/usr/bin/env python3
"""edge-proxy worker: answers requests and scores every one of them with the bot-scoring module.

The module keeps its feature table in memory that is allocated once, at start, for MAX_FEATURES entries. The features
file is re-read whenever a new version appears. A file that does not fit the table is treated as a broken invariant:
the worker exits and the supervisor starts a new one.
"""
import configparser
import json
import os
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/edge-proxy/proxy.conf"
# capacity of the preallocated feature table; a build-time constant of the module
MAX_FEATURES = 200


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(level, msg):
    print(f"{now()} {level} {msg}", flush=True)


def panic(msg):
    log("FATAL", f"thread 'botscore-loader' panicked: {msg}")
    log("FATAL", "worker exiting")
    sys.stdout.flush()
    os._exit(101)


def read_conf():
    cp = configparser.ConfigParser()
    if not cp.read(CONF):
        raise SystemExit(f"edge-proxy: cannot read {CONF}")
    host, _, port = cp.get("proxy", "listen", fallback="127.0.0.1:8081").partition(":")
    return {
        "host": host,
        "port": int(port or 8081),
        "features_file": cp.get("botscore", "features_file", fallback="/var/lib/edge/features/current.json"),
        "botscore": cp.get("botscore", "enabled", fallback="on").strip().lower() in ("on", "true", "yes", "1"),
    }


class BotScore:
    """the scoring module: a fixed-capacity feature table"""

    def __init__(self, path):
        self.path = path
        self.version = None
        self.features = []
        self.lock = threading.Lock()

    def load(self, first=False):
        try:
            with open(self.path, encoding="utf-8") as f:
                doc = json.load(f)
            version = doc["version"]
            features = doc["features"]
            if not isinstance(features, list):
                raise ValueError("features is not a list")
        except (OSError, ValueError, KeyError) as e:
            if first:
                panic(f"cannot read features file {self.path}: {e}")
            log("ERROR", f"botscore: cannot read features file ({e}), keeping version={self.version}")
            return
        if version == self.version:
            return
        if len(features) > MAX_FEATURES:
            panic(f"feature set has {len(features)} entries, preallocated capacity is {MAX_FEATURES} (features file version={version})")
        with self.lock:
            self.version = version
            self.features = features
        log("INFO", f"botscore: loaded features file version={version}, {len(features)} features")

    def watch(self):
        while True:
            time.sleep(2)
            self.load()

    def score(self, path, client):
        with self.lock:
            n = len(self.features)
        return zlib.crc32(f"{path}|{client}|{n}".encode()) % 99 + 1


def make_handler(botscore):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            body = {"ok": True}
            headers = {}
            if botscore is not None:
                score = botscore.score(self.path, self.headers.get("X-Client", ""))
                body["bot_score"] = score
                headers["X-Bot-Score"] = str(score)
                headers["X-Features-Version"] = str(botscore.version)
            data = (json.dumps(body) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):  # requests are logged by nginx
            pass

    return Handler


def main():
    conf = read_conf()
    botscore = None
    if conf["botscore"]:
        botscore = BotScore(conf["features_file"])
        botscore.load(first=True)
        threading.Thread(target=botscore.watch, name="botscore-loader", daemon=True).start()
    else:
        log("WARN", "botscore: module disabled in the configuration, requests are served without a score")
    server = ThreadingHTTPServer((conf["host"], conf["port"]), make_handler(botscore))
    server.daemon_threads = True
    log("INFO", f"worker started, pid {os.getpid()}, listening on {conf['host']}:{conf['port']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
