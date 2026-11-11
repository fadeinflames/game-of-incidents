#!/usr/bin/env python3
"""trafficgen: the clients of the object store. A steady stream of reads and writes that does not slow down
when the API does: a request that hangs keeps its thread, the next ones are sent anyway."""
import hashlib
import random
import threading
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8080/objects"
INTERVAL = 0.15        # one new request every 150 ms
MAX_IN_FLIGHT = 40
TIMEOUT = 6
SEEDED = 150000        # rows written at build time, see seed-db.sh
in_flight = threading.Semaphore(MAX_IN_FLIGHT)


def md5(text):
    return hashlib.md5(str(text).encode()).hexdigest()


def seeded_path(i):
    return f"/acct-{1000 + i % 400}/stor/{md5(i)}/{md5(i * 7)[:12]}/part-{i:07d}.bin"


def request(method, path, body=None):
    try:
        req = urllib.request.Request(API + path, data=body, method=method, headers={"User-Agent": "objstore-sdk/1.14"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            r.read()
    except Exception:  # noqa: BLE001  the clients just come back later
        pass
    finally:
        in_flight.release()


def main():
    rnd = random.Random()
    while True:
        if in_flight.acquire(blocking=False):
            if rnd.random() < 0.7:
                args = ("GET", seeded_path(rnd.randint(1, SEEDED)))
            else:
                slot = rnd.randint(0, 2999)
                args = ("PUT", f"/acct-{1000 + slot % 400}/stor/uploads/slot-{slot:04d}.bin", rnd.randbytes(64))
            threading.Thread(target=request, args=args, daemon=True).start()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
