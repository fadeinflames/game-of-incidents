#!/usr/bin/env python3
"""issuer: issues certificates (a stub: it walks the steps of an order and needs the name of every party it talks to).

An order touches the order database (an internal name), two remote validation points and two transparency logs
(external names). A step whose name does not resolve fails the order. The config is re-read for every order.
"""
import argparse
import json
import sys
import time

from clusterdns import Lookup, LookupFailed

CONF = "/etc/issuer/issuer.conf"
STEPS = [
    ("storage", "database"),
    ("validation", "validation_points"),
    ("ct-submit", "transparency_logs"),
]


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} issuer: {msg}", flush=True)


def run_order(conf_path):
    """Returns (ok, steps, error). Each step: {"step", "name", "addr", "via"}."""
    lookup = Lookup(conf_path)
    done = []
    for step, key in STEPS:
        names = [n.strip() for n in lookup.conf.get("issuer", key, fallback="").split(",") if n.strip()]
        for name in names:
            try:
                addr, via = lookup.resolve(name)
            except LookupFailed as e:
                return False, done, f"step {step}: {e}"
            done.append({"step": step, "name": name, "addr": addr, "via": via})
    return True, done, ""


def main():
    ap = argparse.ArgumentParser(description="certificate issuer (stub)")
    ap.add_argument("--check", action="store_true", help="walk one order now, print the result as JSON and exit")
    ap.add_argument("--conf", default=CONF)
    args = ap.parse_args()

    if args.check:
        ok, steps, error = run_order(args.conf)
        print(json.dumps({"ok": ok, "steps": steps, "error": error}))
        sys.exit(0 if ok else 1)

    interval = Lookup(args.conf).conf.getfloat("issuer", "interval_sec", fallback=5.0)
    log(f"started, one order every {interval:g}s")
    order = 48200
    failed_in_a_row = 0
    while True:
        order += 1
        t0 = time.time()
        try:
            ok, steps, error = run_order(args.conf)
        except Exception as e:  # noqa: BLE001  a broken config must not kill the service
            ok, steps, error = False, [], f"config: {e}"
        took = time.time() - t0
        if ok:
            pinned = sorted({s["name"] for s in steps if s["via"] == "static"})
            note = f" (static pins used: {', '.join(pinned)})" if pinned else ""
            if failed_in_a_row:
                log(f"order {order} issued in {took:.2f}s, first success after {failed_in_a_row} failed orders{note}")
            else:
                log(f"order {order} issued in {took:.2f}s{note}")
            failed_in_a_row = 0
        else:
            failed_in_a_row += 1
            log(f"order {order} FAILED after {took:.2f}s at {error}")
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
