#!/usr/bin/env python3
"""media-api: POST /upload/<name> stores the body in the media bucket (and a local cache); GET /files/<name> serves from the
cache first (the "CDN" of the story), then from the bucket. GET /health -> 200 (does not touch the bucket)."""
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import s3
import signal

ENDPOINT = os.environ.get("S3_ENDPOINT", "http://s3.storage.svc:9000")
BUCKET = os.environ.get("S3_BUCKET", "media")
ACCESS = os.environ.get("AWS_ACCESS_KEY_ID", "")
SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
CACHE = os.environ.get("CACHE_DIR", "/tmp/media-cache")
os.makedirs(CACHE, exist_ok=True)


def log(level, msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [{level}] {msg}\n")
    sys.stderr.flush()


def ensure_bucket(attempts=1):
    """create the bucket if it is missing; the gateway may still be starting, so retry at boot"""
    for i in range(attempts):
        try:
            s3.request(ENDPOINT, ACCESS, SECRET, "PUT", BUCKET)
            return True
        except s3.S3Error as e:
            if e.code in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                return True
            log("WARN", f"bucket check failed: {e.status} {e.code}")
            return False
        except Exception as e:  # noqa: BLE001
            log("WARN", f"storage not reachable yet ({e}), retry {i + 1}/{attempts}")
            time.sleep(2)
    return False


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, "ok\n")
        if self.path.startswith("/files/"):
            name = self.path.split("/files/", 1)[1]
            cached = os.path.join(CACHE, name)
            if os.path.exists(cached):
                return self._send(200, open(cached, "rb").read(), "application/octet-stream")
            try:
                _, body = s3.request(ENDPOINT, ACCESS, SECRET, "GET", BUCKET, name)
                return self._send(200, body, "application/octet-stream")
            except s3.S3Error as e:
                log("ERROR", f"GET s3://{BUCKET}/{name} -> {e.status} {e.code} (key {ACCESS[:4]}…)")
                return self._send(404 if e.status == 404 else 500, f"{e.code}\n")
        self._send(404, "not found\n")

    def do_POST(self):
        if not self.path.startswith("/upload/"):
            return self._send(404, "not found\n")
        name = self.path.split("/upload/", 1)[1]
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        try:
            try:
                s3.request(ENDPOINT, ACCESS, SECRET, "PUT", BUCKET, name, body)
            except s3.S3Error as e:
                if e.code != "NoSuchBucket" or not ensure_bucket():
                    raise
                s3.request(ENDPOINT, ACCESS, SECRET, "PUT", BUCKET, name, body)
        except s3.S3Error as e:
            hint = " — no user exists with this access key: the key is stale or was rotated" if e.code in ("InvalidAccessKeyId", "XAdminUserNotFound") else ""
            log("ERROR", f"PUT s3://{BUCKET}/{name} -> {e.status} {e.code} (key {ACCESS[:4]}…){hint}")
            return self._send(500, f"upload failed: {e.code}\n")
        except Exception as e:  # noqa: BLE001
            log("ERROR", f"PUT s3://{BUCKET}/{name} -> {e}")
            return self._send(502, "storage unreachable\n")
        with open(os.path.join(CACHE, name), "wb") as fh:
            fh.write(body)
        self._send(201, f"stored {name} ({n} bytes)\n")

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("INFO", f"media-api: bucket {BUCKET} at {ENDPOINT}, access key {ACCESS[:4]}…")
    ensure_bucket(attempts=15)
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
