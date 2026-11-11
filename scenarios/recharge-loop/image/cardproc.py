#!/usr/bin/env python3
"""cardproc: a stand-in for the external card processor.

  POST   /charges            {"account_id": 1007, "card": "tok_...", "amount_cents": 2000}  -> 201 {"id": "ch_000042", ...}
  GET    /charges/<id>                                                                     -> 200 the charge, or 404
  POST   /refunds            {"charge_id": "ch_000042"}                                    -> 201 new, 200 already requested
  DELETE /refunds/<id>                                                                     -> 200 withdrawn, or 404
  GET    /healthz

Every charge is approved: the processor has no idea whether the merchant had a reason to charge.
"""
import json
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = "/var/lib/cardproc/cardproc.db"
LISTEN = ("127.0.0.1", 8090)
lock = threading.Lock()


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print("%s %s" % (now(), msg), flush=True)


def connect():
    return sqlite3.connect(DB, timeout=10, isolation_level=None)


def charge_row(db, charge_id):
    row = db.execute("SELECT id, ts, account_id, card, amount_cents, status FROM charges WHERE id = ?", (charge_id,)).fetchone()
    if row is None:
        return None
    return dict(zip(("id", "ts", "account_id", "card", "amount_cents", "status"), row))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            return None

    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(200, {"status": "ok"})
        if self.path.startswith("/charges/"):
            with lock:
                db = connect()
                row = charge_row(db, self.path[len("/charges/"):])
                db.close()
            return self.reply(200, row) if row else self.reply(404, {"error": "no such charge"})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        data = self.body()
        if not isinstance(data, dict):
            return self.reply(400, {"error": "a JSON object is expected"})
        if self.path == "/charges":
            try:
                account, card, amount = int(data["account_id"]), str(data["card"]), int(data["amount_cents"])
            except (KeyError, ValueError, TypeError):
                return self.reply(400, {"error": "account_id, card and amount_cents are required"})
            if amount <= 0:
                return self.reply(400, {"error": "amount_cents must be positive"})
            with lock:
                db = connect()
                db.execute("BEGIN IMMEDIATE")
                seq = db.execute("INSERT INTO charges (id, ts, account_id, card, amount_cents) VALUES ('', ?, ?, ?, ?)",
                                 (now(), account, card, amount)).lastrowid
                charge_id = "ch_%06d" % seq
                db.execute("UPDATE charges SET id = ? WHERE seq = ?", (charge_id, seq))
                db.execute("COMMIT")
                db.close()
            log("charge %s account=%d card=%s amount=%d approved" % (charge_id, account, card, amount))
            return self.reply(201, {"id": charge_id, "status": "approved"})
        if self.path == "/refunds":
            charge_id = str(data.get("charge_id", ""))
            with lock:
                db = connect()
                row = charge_row(db, charge_id)
                if row is None:
                    db.close()
                    return self.reply(404, {"error": "no such charge"})
                known = db.execute("SELECT 1 FROM refunds WHERE charge_id = ?", (charge_id,)).fetchone()
                if not known:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("INSERT INTO refunds (charge_id, ts, amount_cents) VALUES (?, ?, ?)",
                               (charge_id, now(), row["amount_cents"]))
                    db.execute("UPDATE charges SET status = 'refund_pending' WHERE id = ?", (charge_id,))
                    db.execute("COMMIT")
                db.close()
            if known:
                return self.reply(200, {"charge_id": charge_id, "status": "already requested", "charge": row})
            log("refund requested %s account=%d amount=%d" % (charge_id, row["account_id"], row["amount_cents"]))
            return self.reply(201, {"charge_id": charge_id, "status": "pending", "charge": row})
        self.reply(404, {"error": "not found"})

    def do_DELETE(self):
        if not self.path.startswith("/refunds/"):
            return self.reply(404, {"error": "not found"})
        charge_id = self.path[len("/refunds/"):]
        with lock:
            db = connect()
            known = db.execute("SELECT 1 FROM refunds WHERE charge_id = ?", (charge_id,)).fetchone()
            if known:
                db.execute("BEGIN IMMEDIATE")
                db.execute("DELETE FROM refunds WHERE charge_id = ?", (charge_id,))
                db.execute("UPDATE charges SET status = 'approved' WHERE id = ?", (charge_id,))
                db.execute("COMMIT")
            db.close()
        if not known:
            return self.reply(404, {"error": "no refund for this charge"})
        log("refund withdrawn %s" % charge_id)
        self.reply(200, {"charge_id": charge_id, "status": "withdrawn"})


if __name__ == "__main__":
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    log("cardproc listening on %s:%d" % LISTEN)
    server.serve_forever()
