#!/usr/bin/env python3
"""storefront: order intake of the shop.

Accepts a new order every couple of seconds and moves some of its earlier orders to the next status.
Every write goes to the production cluster; a failed write is logged and retried on the next tick.
"""
import configparser
import random
import sys
import time
from datetime import datetime, timezone

import psycopg2

CONF = "/etc/storefront/storefront.conf"

INSERT = (
    "WITH n AS (SELECT nextval('orders_id_seq') AS id) "
    "INSERT INTO orders (id, order_no, merchant_id, amount_cents, status) "
    "SELECT id, 'WEB-' || lpad(id::text, 7, '0'), %s, %s, 'new' FROM n RETURNING id, order_no"
)


def log(level, msg):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} {level} {msg}", flush=True)


def first_line(err):
    return str(err).strip().splitlines()[0] if str(err).strip() else err.__class__.__name__


def main():
    cfg = configparser.ConfigParser(interpolation=None)
    cfg.read(CONF)
    dsn = cfg.get("storefront", "dsn")
    interval = cfg.getfloat("storefront", "interval_sec", fallback=2.0)
    conn = None
    mine = []  # ids of the orders accepted by this process that are still 'new'
    tick = 0
    log("INFO", "storefront started")
    while True:
        tick += 1
        try:
            if conn is None or conn.closed:
                conn = psycopg2.connect(dsn)
                conn.autocommit = True
                log("INFO", "connected to the database")
            with conn.cursor() as cur:
                merchant = random.randint(1, 48)
                amount = random.randint(500, 45000)
                cur.execute(INSERT, (merchant, amount))
                oid, order_no = cur.fetchone()
                mine.append(oid)
                log("INFO", f"order {order_no} accepted: merchant={merchant} amount={amount / 100:.2f}")
                if tick % 4 == 0 and len(mine) > 3:
                    paid = mine.pop(0)
                    cur.execute("UPDATE orders SET status = 'paid' WHERE id = %s AND status = 'new'", (paid,))
                    log("INFO", f"order id={paid} paid")
        except psycopg2.Error as err:
            log("ERROR", f"write failed: {first_line(err)}")
            try:
                if conn is not None:
                    conn.close()
            except psycopg2.Error:
                pass
            conn = None
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
