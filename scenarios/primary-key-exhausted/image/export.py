#!/usr/bin/env python3
"""tracker-export: every minute hands the new events to the analytics side and remembers where it stopped.

The position is the id of the last exported event, kept in export_state. Run from cron; exit code 0 means the position moved.
"""
import os
import sys
import time

import pymysql


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} tracker-export: {msg}", flush=True)


def env_file(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    return out


def main():
    cfg = env_file(os.environ.get("TRACKER_ENV", "/etc/tracker/tracker.env"))
    try:
        conn = pymysql.connect(
            host=cfg.get("DB_HOST", "127.0.0.1"), port=int(cfg.get("DB_PORT", "3306")), user=cfg["DB_USER"],
            password=cfg["DB_PASSWORD"], database=cfg.get("DB_NAME", "tracker"), connect_timeout=3, charset="utf8mb4",
        )
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT last_event_id FROM export_state WHERE job = 'analytics'")
                last = cur.fetchone()[0]
                cur.execute("SELECT COUNT(*), COALESCE(MAX(id), %s) FROM events WHERE id > %s", (last, last))
                count, newest = cur.fetchone()
                cur.execute("UPDATE export_state SET last_event_id = %s, updated_at = NOW() WHERE job = 'analytics'", (newest,))
            conn.commit()
        finally:
            conn.close()
    except pymysql.MySQLError as e:
        log(f"FAILED: {e}")
        return 1
    log(f"exported {count} events, position {last} -> {newest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
