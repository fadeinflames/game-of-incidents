#!/usr/bin/env python3
"""emitter (stand): the rest of the product. Publishes payment events for the hooks of six customers to the
stream `events`, EVENTS_PER_SEC of them every second."""
import json
import logging
import os
import random
import signal
import sys
import threading
import time

import redis

STREAM = os.environ.get("EVENTS_STREAM", "events")
RATE = float(os.environ.get("EVENTS_PER_SEC", "2"))
HOOKS = ("hk-1042", "hk-1187", "hk-2210", "hk-3051", "hk-4476", "hk-5093")
EVENTS = ("payment.succeeded", "payment.succeeded", "payment.succeeded", "payment.refunded", "invoice.paid", "payout.created")

logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("emitter")
stopping = threading.Event()


def main():
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    client = redis.Redis(host=os.environ.get("REDIS_HOST", "redis"), port=6379, decode_responses=True, socket_connect_timeout=3, socket_timeout=5)
    rnd = random.Random()
    log.info("emitter starting: %s events per second to stream %s for hooks %s", RATE, STREAM, ", ".join(HOOKS))
    published = 0
    reported = 0
    last_report = time.monotonic()
    next_at = time.monotonic()
    while not stopping.is_set():
        now = time.monotonic()
        if now < next_at:
            stopping.wait(min(next_at - now, 0.5))
            continue
        # a pause (Redis away, a slow node) is not made up for with a burst
        next_at = max(next_at + 1.0 / RATE, now)
        event = rnd.choice(EVENTS)
        payload = {
            "id": "evt_%012x" % rnd.getrandbits(48),
            "type": event,
            "created": int(time.time()),
            "data": {"order": "R-%06d" % rnd.randrange(1000000), "amount": rnd.randrange(100, 250000) / 100, "currency": "RUB"},
        }
        try:
            client.xadd(STREAM, {"hook": rnd.choice(HOOKS), "event": event, "payload": json.dumps(payload, separators=(",", ":"))})
            published += 1
        except (redis.ConnectionError, redis.TimeoutError) as e:
            log.warning("cannot publish an event: %s", e)
            stopping.wait(1)
        except redis.ResponseError as e:
            log.error("redis refused an event: %s", e)
            stopping.wait(1)
        if time.monotonic() - last_report >= 30:
            log.info("30 s: %d events published to stream %s", published - reported, STREAM)
            reported = published
            last_report = time.monotonic()
    log.info("emitter stopped")


if __name__ == "__main__":
    main()
