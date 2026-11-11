#!/usr/bin/env python3
"""mon-agent: collects samples from the internal hosts and pushes them to the hosted metrics service (a stub).

Every cycle it resolves its scrape targets (internal names) and the ingest endpoint (an external name). Samples that
cannot be delivered stay in the buffer, and the dashboards show nothing until they are flushed.
"""
import argparse
import json
import sys
import time

from clusterdns import Lookup, LookupFailed

CONF = "/etc/mon-agent/agent.conf"
SAMPLES_PER_TARGET = 12


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} mon-agent: {msg}", flush=True)


def names(lookup, key):
    return [n.strip() for n in lookup.conf.get("agent", key, fallback="").split(",") if n.strip()]


def cycle(conf_path):
    """Returns (scraped targets, push ok, lookups, error)."""
    lookup = Lookup(conf_path)
    seen = []
    scraped = 0
    for name in names(lookup, "targets"):
        try:
            addr, via = lookup.resolve(name)
        except LookupFailed:
            continue
        scraped += 1
        seen.append({"step": "scrape", "name": name, "addr": addr, "via": via})
    ingest = lookup.conf.get("agent", "ingest", fallback="").strip()
    try:
        addr, via = lookup.resolve(ingest)
    except LookupFailed as e:
        return scraped, False, seen, str(e)
    seen.append({"step": "push", "name": ingest, "addr": addr, "via": via})
    return scraped, True, seen, ""


def main():
    ap = argparse.ArgumentParser(description="monitoring agent (stub)")
    ap.add_argument("--check", action="store_true", help="run one cycle now, print the result as JSON and exit")
    ap.add_argument("--conf", default=CONF)
    args = ap.parse_args()

    if args.check:
        scraped, pushed, seen, error = cycle(args.conf)
        print(json.dumps({"ok": pushed and scraped > 0, "steps": seen, "error": error}))
        sys.exit(0 if pushed and scraped > 0 else 1)

    interval = Lookup(args.conf).conf.getfloat("agent", "interval_sec", fallback=10.0)
    log(f"started, one cycle every {interval:g}s")
    buffered = 0
    since = None
    while True:
        try:
            scraped, pushed, seen, error = cycle(args.conf)
        except Exception as e:  # noqa: BLE001  a broken config must not kill the agent
            scraped, pushed, seen, error = 0, False, [], f"config: {e}"
        buffered += scraped * SAMPLES_PER_TARGET
        if pushed:
            pinned = sorted({s["name"] for s in seen if s["via"] == "static"})
            note = f" (static pins used: {', '.join(pinned)})" if pinned else ""
            if since:
                log(f"push ok: {buffered} samples delivered, the backlog since {since} is flushed{note}")
            else:
                log(f"push ok: {buffered} samples delivered{note}")
            buffered, since = 0, None
        else:
            since = since or now()
            log(f"push FAILED: {error}; {buffered} samples buffered since {since}, dashboards get nothing")
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
