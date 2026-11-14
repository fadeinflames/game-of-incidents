#!/usr/bin/env python3
"""dispatcher: takes events from the stream `events`, delivers each one to the endpoint of its hook (one HTTP POST)
and hands the delivery record over to the recorder through the stream `deliveries`.

Delivery is at most once: an event is acknowledged before the POST, so a dispatcher that dies in the middle never
sends the same event twice. The id of a delivery is derived from the id of the event."""
import hashlib
import os
import socket
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

import redis

import common
import recordfmt

EVENTS = os.environ.get("EVENTS_STREAM", "events")
RECORDS = os.environ.get("RECORDS_STREAM", "deliveries")
GROUP = os.environ.get("EVENTS_GROUP", "dispatcher")
CONSUMER = os.environ.get("HOSTNAME", "dispatcher")
# on this stand every hook lives under one base URL; in production the URL is a property of the hook
ENDPOINT_BASE = os.environ.get("CUSTOMER_ENDPOINT_BASE", "http://customers.outside.svc.cluster.local:8080/hooks").rstrip("/")
DELIVERY_NS = uuid.UUID("6f1d2c5e-8a47-4b0e-9f31-2d7c4a5b9e10")

log = common.setup("dispatcher")
counters = {
    "dispatcher_events_taken_total": 0,
    "dispatcher_deliveries_2xx_total": 0,
    "dispatcher_deliveries_failed_total": 0,
    "dispatcher_records_handed_off_total": 0,
}
HELP = {
    "dispatcher_events_taken_total": "Events taken from the stream of events.",
    "dispatcher_deliveries_2xx_total": "Deliveries the customer endpoint answered with 2xx.",
    "dispatcher_deliveries_failed_total": "Deliveries that got another status or no answer.",
    "dispatcher_records_handed_off_total": "Delivery records written to the stream read by the recorder.",
}


def post(hook, event, delivery_id, body):
    req = urllib.request.Request(
        "%s/%s" % (ENDPOINT_BASE, hook),
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "hooks-dispatcher/%s" % common.RELEASE,
            "X-Hook-Id": hook,
            "X-Event": event,
            "X-Delivery-Id": delivery_id,
        },
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception:  # noqa: BLE001
        status = 0
    return status, int((time.monotonic() - t0) * 1000)


def hand_off(client, record):
    """The delivery has happened: the record must reach the stream, so this waits for Redis as long as it takes."""
    while True:
        try:
            client.xadd(RECORDS, recordfmt.encode(record))
            counters["dispatcher_records_handed_off_total"] += 1
            return
        except (redis.ConnectionError, redis.TimeoutError) as e:
            log.warning("cannot hand off the record of delivery %s: %s; retrying", record["delivery_id"], e)
            time.sleep(1)


def deliver(client, event_id, fields):
    hook = fields.get("hook", "")
    event = fields.get("event", "")
    body = fields.get("payload", "").encode()
    if not hook:
        log.warning("event %s has no hook, dropped", event_id)
        return
    delivery_id = str(uuid.uuid5(DELIVERY_NS, event_id))
    status, ms = post(hook, event, delivery_id, body)
    if 200 <= status < 300:
        counters["dispatcher_deliveries_2xx_total"] += 1
    else:
        counters["dispatcher_deliveries_failed_total"] += 1
        log.warning("delivery %s to hook %s: status %s in %s ms", delivery_id, hook, status or "none", ms)
    hand_off(client, {
        "delivery_id": delivery_id,
        "hook_id": hook,
        "event": event,
        "status": status,
        "duration_ms": ms,
        "delivered_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "payload_sha256": hashlib.sha256(body).hexdigest(),
    })


def wait_for_endpoints():
    """Stand only: every hook lives on one server, so it is worth waiting for it at start instead of opening the
    history with a failed delivery. In production an endpoint that is down is the customer's business."""
    url = urlsplit(ENDPOINT_BASE)
    deadline = time.monotonic() + 60
    while not common.stopping.is_set() and time.monotonic() < deadline:
        try:
            socket.create_connection((url.hostname, url.port or 80), timeout=2).close()
            return
        except OSError:
            time.sleep(1)


def main():
    log.info("dispatcher %s starting: events from stream %s (group %s, consumer %s), delivery records to stream %s in handoff format %s (%s)",
             common.RELEASE, EVENTS, GROUP, CONSUMER, RECORDS, recordfmt.FORMAT, recordfmt.DESCRIPTION)
    common.serve_http(9102, {
        "/healthz": lambda: (200, "text/plain", "ok\n"),
        "/metrics": lambda: (200, "text/plain", common.metrics_text("dispatcher", recordfmt.FORMAT, counters, HELP)),
    })
    wait_for_endpoints()
    client = common.redis_client()
    group_ready = False
    last_report = time.monotonic()
    seen = dict(counters)
    while not common.stopping.is_set():
        try:
            if not group_ready:
                common.ensure_group(client, EVENTS, GROUP)
                group_ready = True
            resp = client.xreadgroup(GROUP, CONSUMER, {EVENTS: ">"}, count=1, block=1000)
            for _stream, entries in resp or []:
                for event_id, fields in entries:
                    client.xack(EVENTS, GROUP, event_id)
                    counters["dispatcher_events_taken_total"] += 1
                    deliver(client, event_id, fields or {})
        except redis.ResponseError as e:
            if "NOGROUP" in str(e):
                log.warning("consumer group %s is missing on stream %s, creating it again", GROUP, EVENTS)
                group_ready = False
            else:
                log.error("redis: %s", e)
                time.sleep(1)
        except (redis.ConnectionError, redis.TimeoutError) as e:
            log.warning("redis is not reachable: %s", e)
            time.sleep(1)
        if time.monotonic() - last_report >= 30:
            d = {k: counters[k] - seen[k] for k in counters}
            log.info("30 s: %d events delivered (%d answered 2xx), %d delivery records handed off to stream %s",
                     d["dispatcher_events_taken_total"], d["dispatcher_deliveries_2xx_total"], d["dispatcher_records_handed_off_total"], RECORDS)
            seen = dict(counters)
            last_report = time.monotonic()
    log.info("dispatcher %s stopped", common.RELEASE)


if __name__ == "__main__":
    main()
