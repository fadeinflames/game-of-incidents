#!/usr/bin/env python3
"""engine: a translation engine (stand-in). The engine name and the port come from the environment.

POST /translate  {"text": "..."} -> {"engine": "...", "text": "..."}
GET  /healthz    the engine is alive, with its queue length and the number of jobs done
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENGINE = os.environ.get("ENGINE", "std")
PORT = int(os.environ.get("PORT", "9201"))
JOB_SEC = 0.03
STARTED = time.time()
LOCK = threading.Lock()
STATE = {"in_progress": 0, "done": 0}


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} engine-{ENGINE}: {msg}", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

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

    def do_GET(self):
        if self.path != "/healthz":
            return self._send(404, {"error": "not_found"})
        with LOCK:
            doc = {"status": "ok", "engine": ENGINE, "queue": STATE["in_progress"], "jobs_done": STATE["done"],
                   "uptime_sec": int(time.time() - STARTED)}
        self._send(200, doc)

    def do_POST(self):
        if self.path != "/translate":
            return self._send(404, {"error": "not_found"})
        try:
            text = str(json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))["text"])
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad_request"})
        t0 = time.monotonic()
        with LOCK:
            STATE["in_progress"] += 1
        time.sleep(JOB_SEC)
        with LOCK:
            STATE["in_progress"] -= 1
            STATE["done"] += 1
        log(f"job done: {len(text)} characters in {int((time.monotonic() - t0) * 1000)} ms")
        self._send(200, {"engine": ENGINE, "text": f"[{ENGINE}] {text}"})

    def log_message(self, *_args):
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


if __name__ == "__main__":
    log(f"listening on 127.0.0.1:{PORT}")
    Server(("127.0.0.1", PORT), Handler).serve_forever()
