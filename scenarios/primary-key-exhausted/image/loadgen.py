#!/usr/bin/env python3
"""loadgen: the users of the product. Every action (a comment, a task, an upload) is one POST /events."""
import json
import time
import urllib.error
import urllib.request

URL = "http://127.0.0.1:8080/events"
KINDS = ["comment", "task_created", "task_done", "upload", "mention", "login"]


def main():
    n = 0
    while True:
        body = json.dumps({"user_id": 1000 + n % 400, "kind": KINDS[n % len(KINDS)]}).encode()
        req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:  # noqa: BLE001  a failed action is the user's problem; the next one is tried anyway
            pass
        n += 1
        time.sleep(0.5)


if __name__ == "__main__":
    main()
