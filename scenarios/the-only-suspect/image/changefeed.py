#!/usr/bin/env python3
"""changefeed: ships row changes of the objects table to billing.

A trigger on the table writes every change into object_changes. This daemon reads that table once a second, appends
the changes to the feed file and removes what it has shipped. Every time it opens a database session it first makes
sure that the capture trigger is there; how it does that is set by on_connect in the config.
"""
import configparser
import json
import os
import sys
import time

import psycopg2

CONF = "/etc/changefeed/changefeed.conf"
FEED_MAX_BYTES = 4 * 1024 * 1024


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} changefeed: {msg}", flush=True)


def read_conf():
    cp = configparser.ConfigParser()
    if not cp.read(CONF):
        raise SystemExit(f"changefeed: cannot read {CONF}")
    conf = {
        "dsn": cp.get("database", "dsn"),
        "max_age": cp.getfloat("database", "conn_max_age_sec", fallback=30),
        "delay": cp.getfloat("database", "reconnect_delay_sec", fallback=2),
        "table": cp.get("capture", "table", fallback="objects"),
        "trigger": cp.get("capture", "trigger", fallback="objects_changefeed"),
        "on_connect": cp.get("capture", "on_connect", fallback="recreate").strip().lower(),
        "feed": cp.get("output", "feed", fallback="/var/lib/changefeed/feed.jsonl"),
        "offset_file": cp.get("output", "offset_file", fallback="/var/lib/changefeed/offset"),
        "poll": cp.getfloat("output", "poll_sec", fallback=1),
    }
    if conf["on_connect"] not in ("recreate", "verify", "skip"):
        raise SystemExit(f"changefeed: on_connect = {conf['on_connect']!r}, expected recreate, verify or skip")
    return conf


def create_trigger_sql(conf):
    return (f"CREATE TRIGGER {conf['trigger']} AFTER INSERT OR UPDATE OR DELETE ON {conf['table']} "
            "FOR EACH ROW EXECUTE FUNCTION changefeed_capture()")


def ensure_trigger(conn, conf):
    mode = conf["on_connect"]
    if mode == "skip":
        log("on_connect=skip: the capture trigger is not touched")
        return
    started = time.monotonic()
    log(f"ensuring capture trigger {conf['trigger']} on {conf['table']} (on_connect={mode})")
    with conn.cursor() as cur:
        if mode == "recreate":
            # one transaction: the table is never left without the trigger
            cur.execute(f"DROP TRIGGER IF EXISTS {conf['trigger']} ON {conf['table']}")
            cur.execute(create_trigger_sql(conf))
        else:
            cur.execute("SELECT 1 FROM pg_trigger WHERE tgrelid = %s::regclass AND tgname = %s AND NOT tgisinternal",
                        (conf["table"], conf["trigger"]))
            if cur.fetchone() is None:
                log(f"capture trigger {conf['trigger']} is missing, creating it")
                cur.execute(create_trigger_sql(conf))
    conn.commit()
    log(f"capture trigger {conf['trigger']} is in place ({int((time.monotonic() - started) * 1000)} ms)")


def read_offset(path):
    try:
        with open(path, encoding="ascii") as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def write_offset(path, value):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="ascii") as f:
        f.write(f"{value}\n")
    os.replace(tmp, path)


def ship(conn, conf, offset):
    """Append new changes to the feed, remove them from the queue table. Returns (new offset, shipped)."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, path, op, at FROM object_changes WHERE id > %s ORDER BY id LIMIT 500", (offset,))
        rows = cur.fetchall()
        if not rows:
            conn.commit()
            return offset, 0
        try:
            if os.path.getsize(conf["feed"]) > FEED_MAX_BYTES:
                os.replace(conf["feed"], conf["feed"] + ".1")
        except OSError:
            pass
        with open(conf["feed"], "a", encoding="utf-8") as f:
            for cid, path, op, at in rows:
                f.write(json.dumps({"id": cid, "path": path, "op": op, "at": at.isoformat()}) + "\n")
        offset = rows[-1][0]
        write_offset(conf["offset_file"], offset)
        cur.execute("DELETE FROM object_changes WHERE id <= %s", (offset,))
    conn.commit()
    return offset, len(rows)


def session(conf):
    """One database session: from connect to recycle."""
    conn = psycopg2.connect(conf["dsn"], application_name="changefeed")
    try:
        born = time.monotonic()
        log(f"connected to the database (backend pid {conn.get_backend_pid()})")
        ensure_trigger(conn, conf)
        offset = read_offset(conf["offset_file"])
        shipped, last_report = 0, time.monotonic()
        while True:
            offset, n = ship(conn, conf, offset)
            shipped += n
            if time.monotonic() - last_report >= 10:
                log(f"shipped {shipped} changes in the last 10 s, offset {offset}")
                shipped, last_report = 0, time.monotonic()
            if time.monotonic() - born >= conf["max_age"]:
                log(f"session is {int(time.monotonic() - born)} s old, opening a new one")
                return
            time.sleep(conf["poll"])
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def main():
    conf = read_conf()
    log(f"started, on_connect={conf['on_connect']}, session max age {int(conf['max_age'])} s")
    while True:
        try:
            session(conf)
        except psycopg2.Error as e:
            text = (getattr(e, "pgerror", None) or str(e) or e.__class__.__name__).strip().splitlines()
            log(f"database error: {text[0] if text else e.__class__.__name__}; reconnecting in {conf['delay']:g} s")
        time.sleep(conf["delay"])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
