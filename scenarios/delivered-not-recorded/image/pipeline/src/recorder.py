#!/usr/bin/env python3
"""recorder: reads delivery records from the stream `deliveries` (consumer group `recorder`) and writes them to the
deliveries store (PostgreSQL, table deliveries). The store is keyed by delivery_id: writing a record that is already
there changes nothing, so a batch can safely be processed again after a failure.

One recorder at a time (the Deployment uses the Recreate strategy), the consumer name is fixed."""
import os
import time

import redis

import common
import recordfmt

STREAM = os.environ.get("RECORDS_STREAM", "deliveries")
GROUP = os.environ.get("RECORDS_GROUP", "recorder")
CONSUMER = os.environ.get("RECORDS_CONSUMER", "recorder-1")
BATCH = int(os.environ.get("BATCH", "200"))

INSERT = (
    "INSERT INTO deliveries (delivery_id, hook_id, event, status, duration_ms, delivered_at, payload_sha256) "
    "VALUES (:delivery_id, :hook_id, :event, :status, :duration_ms, CAST(:delivered_at AS timestamptz), :payload_sha256) "
    "ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id"
)

log = common.setup("recorder")
counters = {
    "recorder_entries_read_total": 0,
    "recorder_entries_acknowledged_total": 0,
    "recorder_records_stored_total": 0,
    "recorder_records_already_stored_total": 0,
    "recorder_entries_skipped_total": 0,
    "recorder_records_rejected_total": 0,
}
HELP = {
    "recorder_entries_read_total": "Stream entries read from the consumer group.",
    "recorder_entries_acknowledged_total": "Stream entries acknowledged to the consumer group.",
    "recorder_records_stored_total": "Delivery records written to the deliveries store.",
    "recorder_records_already_stored_total": "Delivery records that were in the store already (same delivery_id).",
    "recorder_entries_skipped_total": "Stream entries that are not delivery records in the handoff format of this release: acknowledged, not stored.",
    "recorder_records_rejected_total": "Delivery records the store refused as invalid data.",
}


def sqlstate(e):
    arg = e.args[0] if e.args else None
    return arg.get("C", "") if isinstance(arg, dict) else ""


def store_batch(conn, records):
    new = 0
    conn.run("BEGIN")
    try:
        for rec in records:
            if conn.run(INSERT, **rec):
                new += 1
        conn.run("COMMIT")
    except Exception:
        try:
            conn.run("ROLLBACK")
        except Exception:  # noqa: BLE001
            pass
        raise
    return new


def store(conn, records):
    """One transaction per batch. Returns how many records were new. A record the store rejects as data
    (a broken timestamp, a missing value) must not hold the others back: such a batch is written record by record."""
    try:
        return store_batch(conn, records)
    except Exception as e:  # noqa: BLE001
        if sqlstate(e)[:2] not in ("22", "23"):
            raise
    new = 0
    for rec in records:
        try:
            new += store_batch(conn, [rec])
        except Exception as e:  # noqa: BLE001
            if sqlstate(e)[:2] not in ("22", "23"):
                raise
            counters["recorder_records_rejected_total"] += 1
            log.error("the store rejected the record of delivery %s: %s", rec.get("delivery_id"), e)
    return new


def lag(client):
    try:
        for g in client.xinfo_groups(STREAM):
            if g.get("name") == GROUP:
                return g.get("lag")
    except Exception:  # noqa: BLE001
        pass
    return None


def main():
    log.info("recorder %s starting: delivery records from stream %s (group %s, consumer %s) in handoff format %s (%s), store: table deliveries",
             common.RELEASE, STREAM, GROUP, CONSUMER, recordfmt.FORMAT, recordfmt.DESCRIPTION)
    common.serve_http(9102, {
        "/healthz": lambda: (200, "text/plain", "ok\n"),
        "/metrics": lambda: (200, "text/plain", common.metrics_text("recorder", recordfmt.FORMAT, counters, HELP)),
    })
    client = common.redis_client()
    conn = None
    group_ready = False
    # "0": first whatever this consumer has read earlier and has not acknowledged, then ">": new entries
    cursor = "0"
    last_report = time.monotonic()
    seen = dict(counters)
    while not common.stopping.is_set():
        try:
            if not group_ready:
                if common.ensure_group(client, STREAM, GROUP):
                    log.info("consumer group %s created on stream %s at the beginning of the stream", GROUP, STREAM)
                group_ready = True
            resp = client.xreadgroup(GROUP, CONSUMER, {STREAM: cursor}, count=BATCH, block=1000)
            entries = resp[0][1] if resp else []
            if not entries and cursor == "0":
                cursor = ">"
            if entries:
                counters["recorder_entries_read_total"] += len(entries)
                records = []
                skipped = 0
                for entry_id, fields in entries:
                    rec = recordfmt.decode(fields) if fields else None
                    if rec is None:
                        # not a delivery record (a marker, an entry of another kind): nothing to store, do not block the stream
                        skipped += 1
                        log.debug("entry %s is not a delivery record in handoff format %s (fields: %s): acknowledged, not stored",
                                  entry_id, recordfmt.FORMAT, ",".join(sorted(fields)) if fields else "none")
                    else:
                        records.append(rec)
                if records:
                    if conn is None:
                        conn = common.pg_connect()
                    rejected = counters["recorder_records_rejected_total"]
                    new = store(conn, records)
                    rejected = counters["recorder_records_rejected_total"] - rejected
                    counters["recorder_records_stored_total"] += new
                    counters["recorder_records_already_stored_total"] += len(records) - new - rejected
                client.xack(STREAM, GROUP, *[entry_id for entry_id, _ in entries])
                counters["recorder_entries_acknowledged_total"] += len(entries)
                counters["recorder_entries_skipped_total"] += skipped
        except redis.ResponseError as e:
            if "NOGROUP" in str(e):
                log.warning("consumer group %s is missing on stream %s, creating it again", GROUP, STREAM)
                group_ready = False
            else:
                log.error("redis: %s", e)
                time.sleep(1)
            cursor = "0"
        except (redis.ConnectionError, redis.TimeoutError) as e:
            log.warning("redis is not reachable: %s", e)
            cursor = "0"
            time.sleep(1)
        except Exception as e:  # noqa: BLE001
            # the store did not take the batch: nothing is acknowledged, the same entries are read again
            log.warning("the deliveries store did not take the batch: %r; the batch will be processed again", e)
            try:
                if conn is not None:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
            cursor = "0"
            time.sleep(1)
        if time.monotonic() - last_report >= 30:
            d = {k: counters[k] - seen[k] for k in counters}
            current = lag(client)
            log.info("30 s: %d entries read, %d acknowledged, consumer group lag %s",
                     d["recorder_entries_read_total"], d["recorder_entries_acknowledged_total"], "unknown" if current is None else current)
            seen = dict(counters)
            last_report = time.monotonic()
    log.info("recorder %s stopped", common.RELEASE)


if __name__ == "__main__":
    main()
