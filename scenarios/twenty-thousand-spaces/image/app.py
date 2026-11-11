#!/usr/bin/env python3
"""forum web server: a prefork HTTP server (one listening socket, several worker processes).

GET  /                 home page: the newest questions with an excerpt
GET  /questions/<id>   one question
POST /questions        new question, JSON {"title": "...", "body": "...", "author": "..."}
GET  /health           the process is alive (no database, no rendering)
"""
import html
import json
import os
import signal
import socket
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import render_post  # noqa: E402

DB = os.environ.get("FORUM_DB", "/var/lib/forum/forum.db")
NAME = os.environ.get("INSTANCE", "web")
PORT = int(os.environ.get("PORT", "8001"))
WORKERS = int(os.environ.get("WORKERS", "4"))
HOME_QUESTIONS = 15
MAX_BODY = 200_000


def db():
    conn = sqlite3.connect(DB, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def page(title, inner):
    return f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title></head><body><h1>{html.escape(title)}</h1>{inner}</body></html>\n"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode()
        self._status = code
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Served-By", NAME)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # the client (or the balancer's health check) gave up before the answer was ready
            print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {NAME} pid={os.getpid()} {self.command} {self.path}: client closed the connection before the response", flush=True)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, "ok\n", "text/plain")
        if self.path == "/":
            with db() as c:
                rows = c.execute("SELECT id, title, body, author FROM questions ORDER BY id DESC LIMIT ?", (HOME_QUESTIONS,)).fetchall()
            items = []
            for r in rows:
                excerpt = render_post(r["body"])[:400]
                items.append(f"<li><a href='/questions/{r['id']}'>{html.escape(r['title'])}</a> <small>{html.escape(r['author'])}</small><p>{excerpt}</p></li>")
            return self._send(200, page("Свежие вопросы", "<ol>" + "".join(items) + "</ol>"))
        if self.path.startswith("/questions/"):
            try:
                qid = int(self.path.rsplit("/", 1)[1])
            except ValueError:
                return self._send(404, page("Не найдено", ""))
            with db() as c:
                r = c.execute("SELECT id, title, body, author FROM questions WHERE id = ?", (qid,)).fetchone()
            if r is None:
                return self._send(404, page("Не найдено", ""))
            return self._send(200, page(r["title"], f"<small>{html.escape(r['author'])}</small><p>{render_post(r['body'])}</p>"))
        return self._send(404, page("Не найдено", ""))

    def do_POST(self):
        if self.path != "/questions":
            return self._send(404, page("Не найдено", ""))
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                return self._send(413, '{"error":"body too large"}\n', "application/json")
            doc = json.loads(self.rfile.read(length))
            title, body = str(doc["title"]).strip(), str(doc["body"])
            author = str(doc.get("author", "anonymous"))[:40]
            if not title or len(title) > 200:
                raise ValueError("bad title")
        except (ValueError, KeyError, TypeError):
            return self._send(400, '{"error":"bad request"}\n', "application/json")
        with db() as c:
            cur = c.execute("INSERT INTO questions (title, body, author, created_at) VALUES (?, ?, ?, ?)", (title, body, author, int(time.time())))
            qid = cur.lastrowid
        return self._send(201, json.dumps({"id": qid}) + "\n", "application/json")

    def handle_one_request(self):
        self._t0 = time.monotonic()
        self._status = 0
        super().handle_one_request()

    def log_request(self, *_args):
        ms = int((time.monotonic() - self._t0) * 1000)
        ua = self.headers.get("User-Agent", "-") if getattr(self, "headers", None) else "-"
        fwd = self.headers.get("X-Forwarded-For", "-") if getattr(self, "headers", None) else "-"
        print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {NAME} pid={os.getpid()} {self.command} {self.path} {self._status} {ms}ms client={fwd} ua={ua}", flush=True)

    def log_message(self, *_args):
        pass


def worker(sock):
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    httpd = HTTPServer(("127.0.0.1", PORT), Handler, bind_and_activate=False)
    httpd.socket = sock
    httpd.serve_forever(poll_interval=0.5)


def main():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", PORT))
    sock.listen(64)
    children = set()

    def spawn():
        pid = os.fork()
        if pid == 0:
            try:
                worker(sock)
            finally:
                os._exit(0)
        children.add(pid)

    def stop(*_a):
        for pid in children:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    for _ in range(WORKERS):
        spawn()
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {NAME} started on 127.0.0.1:{PORT}, {WORKERS} worker processes", flush=True)
    while True:
        try:
            pid, _status = os.wait()
        except ChildProcessError:
            time.sleep(1)
            continue
        children.discard(pid)
        spawn()


if __name__ == "__main__":
    main()
