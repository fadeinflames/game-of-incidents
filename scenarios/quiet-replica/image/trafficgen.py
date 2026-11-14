#!/usr/bin/env python3
"""trafficgen: the clients of the platform. Integrations call the API with their long-lived service tokens, and CI
jobs ask for a short-lived token and use it once. The stream does not slow down when the API does: a request that
hangs keeps its thread, the next ones are sent anyway."""
import hashlib
import json
import random
import threading
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8080"
READ_INTERVAL = 0.2    # an authenticated request every 200 ms
TOKEN_INTERVAL = 0.7   # a CI job starts every 700 ms
MAX_IN_FLIGHT = 60
TIMEOUT = 20
INSTALLS = 16000       # rows written at build time, see seed-db.sh
in_flight = threading.Semaphore(MAX_IN_FLIGHT)


def project_of(install):
    return 1 + (install * 7) % 900


def call(method, path, token=None, body=None):
    headers = {"User-Agent": "platform-sdk/2.9"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read() or b"{}")


def service_request(install):
    try:
        token = "gat_" + hashlib.md5(f"svc-{install}".encode()).hexdigest()
        call("GET", f"/v1/projects/{project_of(install)}", token)
    except Exception:  # noqa: BLE001  the clients just come back later
        pass
    finally:
        in_flight.release()


def ci_job(install, number):
    try:
        doc = call("POST", f"/v1/installs/{install}/access_tokens", body=json.dumps({"label": f"ci-job-{number}"}).encode())
        call("GET", f"/v1/projects/{project_of(install)}", doc["token"])
    except Exception:  # noqa: BLE001
        pass
    finally:
        in_flight.release()


def main():
    rnd = random.Random()
    job = 900000 + rnd.randint(0, 9999)
    next_read = next_job = time.monotonic()
    while True:
        t = time.monotonic()
        if t >= next_read:
            next_read = t + READ_INTERVAL
            if in_flight.acquire(blocking=False):
                threading.Thread(target=service_request, args=(10 * rnd.randint(1, INSTALLS // 10),), daemon=True).start()
        if t >= next_job:
            next_job = t + TOKEN_INTERVAL
            if in_flight.acquire(blocking=False):
                job += 1
                threading.Thread(target=ci_job, args=(rnd.randint(1, INSTALLS), job), daemon=True).start()
        time.sleep(0.05)


if __name__ == "__main__":
    main()
