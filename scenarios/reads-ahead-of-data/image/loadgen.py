#!/usr/bin/env python3
"""loadgen: the integrations of the customers.

Most requests validate a long-lived service token. Now and then an integration asks for a fresh token and uses it at
once, and keeps using it for the next few minutes.
"""
import collections
import hashlib
import json
import random
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8080"
SERVICE_TOKENS = ["it_" + hashlib.sha1(f"seed:{i}".encode()).hexdigest()[:24] for i in range(1, 301)]
recent = collections.deque(maxlen=30)


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception:  # noqa: BLE001  a failed request is the customer's problem; the next one is tried anyway
        return 0, {}


def main():
    rnd = random.Random()
    while call("GET", "/health")[0] != 200:
        time.sleep(1)
    while True:
        r = rnd.random()
        if r < 0.03:
            code, doc = call("POST", "/v1/tokens", {"integration": rnd.randint(1, 40)})
            if code == 201:
                recent.append(doc["token"])
                call("GET", "/v1/tokens/" + doc["token"])
                time.sleep(0.2)
                call("GET", "/v1/tokens/" + doc["token"])
        elif r < 0.08 and recent:
            call("GET", "/v1/tokens/" + rnd.choice(recent))
        else:
            call("GET", "/v1/tokens/" + rnd.choice(SERVICE_TOKENS))
        time.sleep(0.2)


if __name__ == "__main__":
    main()
