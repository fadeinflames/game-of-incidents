#!/usr/bin/env python3
"""trafficgen: visitors of the forum. Most open a question from a search engine, some open the home page."""
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1"


def get(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0 (visitor)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001
        return 0


def main():
    n = 0
    while True:
        path = "/" if n % 5 == 0 else f"/questions/{1 + n % 40}"
        get(path)
        n += 1
        time.sleep(0.4)


if __name__ == "__main__":
    main()
