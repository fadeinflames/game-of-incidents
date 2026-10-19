#!/usr/bin/env python3
"""Tiny upstream application for the scenario. Listens on 127.0.0.1:8081."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys

VERSION = "2.3.1"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            body = b"ok\n"
        else:
            body = f"OK from app v{VERSION}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("%s - - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8081), Handler).serve_forever()
