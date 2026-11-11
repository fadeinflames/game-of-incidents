#!/usr/bin/env python3
"""trafficgen: the clients of the edge. A steady stream of requests; a client that gets an error retries at once."""
import time
import urllib.error
import urllib.request

URL = "http://127.0.0.1/"
CLIENTS = ["shop-web", "shop-mobile", "partner-api", "checkout", "search"]
RETRIES = 3


def get(client, path):
    req = urllib.request.Request(URL + path, headers={"X-Client": client, "User-Agent": f"{client}/2.4"})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            r.read()
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001
        return 0


def main():
    n = 0
    while True:
        client = CLIENTS[n % len(CLIENTS)]
        path = f"api/v1/items/{n % 500}"
        for _attempt in range(1 + RETRIES):
            if get(client, path) == 200:
                break
        n += 1
        time.sleep(0.25)


if __name__ == "__main__":
    main()
