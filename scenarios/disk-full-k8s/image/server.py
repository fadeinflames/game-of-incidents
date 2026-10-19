#!/usr/bin/env python3
"""A compact model of mysqld for the sandbox: data + binlogs on /var/lib/mysql, an HTTP "wire" on :3306
(/health for the app, /query for the `mysql` CLI). Behaves like the real thing where the case needs it:
binlogs grow and rotate, writes fail with ENOSPC when the volume is full, PURGE BINARY LOGS keeps binlog.index
consistent, binlog_expire_logs_seconds prunes old files, SET GLOBAL works at runtime, config comes from conf.d."""
import errno
import glob
import json
import os
import re
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

DATA = os.environ.get("DATADIR", "/var/lib/mysql")
CONF_DIR = "/etc/mysql/conf.d"
ROTATE_AT = 4 * 1024 * 1024
STEP = 128 * 1024  # ~0.4 MiB/min: a purged volume lasts hours, not minutes
MiB = 1024 * 1024

state = {"disk_full": False, "expire": 0, "lock": threading.Lock()}


def log(level, msg):
    sys.stderr.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{level}] {msg}\n")
    sys.stderr.flush()


def read_config():
    val = 0
    for f in sorted(glob.glob(os.path.join(CONF_DIR, "*.cnf"))):
        try:
            for line in open(f):
                m = re.match(r"\s*binlog_expire_logs_seconds\s*=\s*(\d+)", line)
                if m:
                    val = int(m.group(1))
                m = re.match(r"\s*expire_logs_days\s*=\s*(\d+)", line)
                if m:
                    val = int(m.group(1)) * 86400
        except OSError:
            pass
    return val


def write_blob(path, size):
    with open(path, "wb") as fh:
        remaining = size
        chunk = b"\0" * (256 * 1024)
        while remaining > 0:
            n = min(remaining, len(chunk))
            fh.write(chunk[:n])
            remaining -= n


def index_path():
    return os.path.join(DATA, "binlog.index")


def read_index():
    try:
        return [l.strip() for l in open(index_path()) if l.strip()]
    except OSError:
        return []


def write_index(names):
    with open(index_path(), "w") as fh:
        fh.write("".join(n + "\n" for n in names))


def current_binlog():
    idx = read_index()
    return idx[-1] if idx else None


def rotate():
    idx = read_index()
    n = int(idx[-1].split(".")[-1]) + 1 if idx else 1
    name = f"binlog.{n:06d}"
    open(os.path.join(DATA, name), "wb").close()
    write_index(idx + [name])
    return name


def init_data():
    """the database as the sandbox finds it: 12 MiB of tables, 6 MiB of the wordpress schema, one binlog"""
    if os.path.isdir(os.path.join(DATA, "mysql")):
        return
    os.makedirs(os.path.join(DATA, "mysql"), exist_ok=True)
    os.makedirs(os.path.join(DATA, "wordpress"), exist_ok=True)
    for i in range(6):
        write_blob(os.path.join(DATA, "mysql", f"ibdata{i + 1}"), 2 * MiB)
    for t in ("wp_posts", "wp_comments", "wp_options", "wp_users", "wp_postmeta", "wp_terms"):
        write_blob(os.path.join(DATA, "wordpress", f"{t}.ibd"), MiB)
    write_index([])
    rotate()
    log("Note", f"InnoDB: initialized data directory {DATA}")


def append_binlog(size):
    name = current_binlog() or rotate()
    path = os.path.join(DATA, name)
    try:
        with open(path, "ab") as fh:
            fh.write(b"\1" * size)
        if state["disk_full"]:
            log("Note", "disk space available again, binary logging resumed")
        state["disk_full"] = False
        if os.path.getsize(path) >= ROTATE_AT:
            rotate()
        return None
    except OSError as e:
        if e.errno == errno.ENOSPC:
            if not state["disk_full"]:
                log("ERROR", f"[MY-000035] Disk is full writing './{name}' (Errcode: 28 - No space left on device)")
                log("ERROR", "[MY-013132] Cannot create file './mysql/temp_table.ibd' (Errcode: 28)")
                log("Note", "Error number 28 means 'No space left on device'")
            state["disk_full"] = True
            return "Disk is full writing binlog (Errcode: 28 - No space left on device)"
        return str(e)


def expire_old():
    ttl = state["expire"]
    if ttl <= 0:
        return 0
    idx = read_index()
    keep, removed = [], 0
    now = time.time()
    for name in idx:
        p = os.path.join(DATA, name)
        if name != idx[-1] and os.path.exists(p) and now - os.path.getmtime(p) > ttl:
            os.remove(p)
            removed += 1
        else:
            keep.append(name)
    if removed:
        write_index(keep)
        log("Note", f"binlog expiry: purged {removed} file(s) older than {ttl}s")
    return removed


def writer():
    while True:
        time.sleep(20)
        with state["lock"]:
            append_binlog(STEP)
            expire_old()


def disk_free():
    st = os.statvfs(DATA)
    return st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize


def query(sql):
    s = sql.strip().rstrip(";").strip()
    u = s.upper()
    with state["lock"]:
        if u in ("SELECT 1", "SELECT VERSION()"):
            return {"columns": ["version()"], "rows": [["8.0.36-wom"]]}
        if u == "SHOW BINARY LOGS" or u == "SHOW MASTER LOGS":
            rows = []
            for name in read_index():
                p = os.path.join(DATA, name)
                rows.append([name, os.path.getsize(p) if os.path.exists(p) else "MISSING"])
            return {"columns": ["Log_name", "File_size"], "rows": rows}
        if u.startswith("SHOW VARIABLES"):
            m = re.search(r"LIKE\s+'([^']*)'", s, re.I)
            pat = (m.group(1) if m else "%").replace("%", ".*")
            allv = {"binlog_expire_logs_seconds": str(state["expire"]), "datadir": DATA + "/", "log_bin": "ON", "version": "8.0.36-wom"}
            rows = [[k, v] for k, v in allv.items() if re.fullmatch(pat, k)]
            return {"columns": ["Variable_name", "Value"], "rows": rows}
        m = re.match(r"SET\s+(GLOBAL|PERSIST)\s+binlog_expire_logs_seconds\s*=\s*(\d+)", s, re.I)
        if m:
            state["expire"] = int(m.group(2))
            if m.group(1).upper() == "PERSIST":
                try:
                    with open(os.path.join(DATA, "mysqld-auto.cnf"), "w") as fh:
                        fh.write(json.dumps({"binlog_expire_logs_seconds": state["expire"]}))
                except OSError as e:
                    return {"error": f"cannot persist: {e}"}
            expire_old()
            return {"ok": True, "message": "Query OK, 0 rows affected"}
        m = re.match(r"PURGE\s+(BINARY|MASTER)\s+LOGS\s+TO\s+'([^']+)'", s, re.I)
        if m:
            idx = read_index()
            if m.group(2) not in idx:
                return {"error": f"Target log not found in binlog index ({m.group(2)})"}
            cut = idx.index(m.group(2))
            for name in idx[:cut]:
                p = os.path.join(DATA, name)
                if os.path.exists(p):
                    os.remove(p)
            write_index(idx[cut:])
            return {"ok": True, "message": f"Query OK, purged {cut} log(s)"}
        m = re.match(r"PURGE\s+(BINARY|MASTER)\s+LOGS\s+BEFORE\s+", s, re.I)
        if m:
            idx = read_index()
            for name in idx[:-1]:
                p = os.path.join(DATA, name)
                if os.path.exists(p):
                    os.remove(p)
            write_index(idx[-1:])
            return {"ok": True, "message": f"Query OK, purged {max(0, len(idx) - 1)} log(s)"}
        if u == "FLUSH LOGS" or u == "FLUSH BINARY LOGS":
            rotate()
            return {"ok": True, "message": "Query OK, 0 rows affected"}
        if u.startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "ALTER")):
            err = append_binlog(64 * 1024)
            if err:
                return {"error": f"ERROR 1021 (HY000): {err}"}
            return {"ok": True, "message": "Query OK, 1 row affected"}
        if u.startswith("SELECT"):
            return {"columns": ["result"], "rows": [["ok"]]}
        return {"error": f"ERROR 1064 (42000): You have an error in your SQL syntax near '{s[:40]}'"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            free, total = disk_free()
            if state["disk_full"] or free < 2 * MiB:
                self._send(500, json.dumps({"status": "error", "error": "Disk is full (Errcode: 28)", "free_bytes": free}))
            else:
                self._send(200, json.dumps({"status": "ok", "free_bytes": free, "total_bytes": total}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        if self.path != "/query":
            return self._send(404, "{}")
        n = int(self.headers.get("Content-Length") or 0)
        sql = self.rfile.read(n).decode(errors="replace")
        self._send(200, json.dumps(query(sql)))

    def log_message(self, fmt, *args):  # noqa: N802
        pass


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    init_data()
    state["expire"] = read_config()
    try:
        auto = json.load(open(os.path.join(DATA, "mysqld-auto.cnf")))
        state["expire"] = int(auto.get("binlog_expire_logs_seconds", state["expire"]))
    except (OSError, ValueError):
        pass
    log("Note", f"mysqld: ready for connections. Version: '8.0.36-wom' port: 3306 binlog_expire_logs_seconds={state['expire']}")
    threading.Thread(target=writer, daemon=True).start()
    HTTPServer(("0.0.0.0", 3306), Handler).serve_forever()
