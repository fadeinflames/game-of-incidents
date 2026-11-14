#!/usr/bin/env python3
"""loadgen: the users of the product. They open their alerts, dismiss them, mark them as fixed, reopen them."""
import random
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080"
# alert 1 is left alone; the alerts of the routine advisories of the last day have ids up to 15984
FIRST, LAST = 2, 15000
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(method, path):
    req = urllib.request.Request(BASE + path, data=b"" if method == "POST" else None, method=method)
    try:
        OPENER.open(req, timeout=5).read()
    except Exception:  # noqa: BLE001  a failed action is the user's problem; the next one is tried anyway
        pass


def main():
    while True:
        alert = random.randint(FIRST, LAST)
        roll = random.random()
        if roll < 0.35:
            call("GET", "/alerts/%d" % alert)
        elif roll < 0.65:
            call("POST", "/alerts/%d/dismiss" % alert)
        elif roll < 0.85:
            call("POST", "/alerts/%d/resolve" % alert)
        else:
            call("POST", "/alerts/%d/reopen" % alert)
        time.sleep(random.uniform(0.2, 0.45))


if __name__ == "__main__":
    main()
