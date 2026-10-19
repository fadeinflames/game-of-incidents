#!/usr/bin/env python3
"""load-generator: the mobile app. CONCURRENCY workers POST /orders via the edge and RETRY failures immediately
(retry storm). `--probe` sends N sequential card orders and prints status + latency (used by graders and humans)."""
import json
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request

EDGE = os.environ.get("EDGE_URL", "http://edge-gateway/orders")
CONCURRENCY = int(os.environ.get("CONCURRENCY", "12"))
RETRIES = int(os.environ.get("RETRIES", "3"))
TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT", "12"))

counters = {"ok": 0, "fail": 0, "retries": 0}
lock = threading.Lock()


def order(method="card", timeout=TIMEOUT):
    req = urllib.request.Request(EDGE, data=json.dumps({"method": method, "amount": 990}).encode(), headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, time.monotonic() - t0
    except urllib.error.HTTPError as e:
        return e.code, time.monotonic() - t0
    except Exception:  # noqa: BLE001
        return 0, time.monotonic() - t0


def worker():
    while True:
        method = "card" if time.time() % 10 < 8 else "sbp"
        code, _ = order(method)
        attempts = 0
        while code >= 500 or code == 0:
            if attempts >= RETRIES:
                break
            attempts += 1
            with lock:
                counters["retries"] += 1
            code, _ = order(method)
        with lock:
            counters["ok" if code in (200, 201) else "fail"] += 1
        time.sleep(0.5)


def probe(n, timeout=6.0):
    ok = True
    for _ in range(n):
        code, dt = order("card", timeout=timeout)
        print(f"card order -> {code} in {dt:.2f}s", flush=True)
        ok = ok and code in (201, 503) and dt < 5.0
    print("PROBE_OK" if ok else "PROBE_FAIL", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    # PID 1 ignores SIGTERM unless it has a handler; exit at once instead of waiting out terminationGracePeriod
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if len(sys.argv) > 1 and sys.argv[1] == "--probe":
        sys.exit(probe(int(sys.argv[2]) if len(sys.argv) > 2 else 5, float(sys.argv[3]) if len(sys.argv) > 3 else 6.0))
    for _ in range(CONCURRENCY):
        threading.Thread(target=worker, daemon=True).start()
    while True:
        time.sleep(10)
        with lock:
            sys.stderr.write(f"{time.strftime('%H:%M:%S')} loadgen: {json.dumps(counters)}\n")
