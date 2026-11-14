"""Handoff format of a delivery record between the dispatcher (writes) and the recorder (reads).

Format 2: the record is one JSON document in the stream field "rec". The envelope leaves room for response
headers and retry attempts, which do not fit flat fields.
"""
import json

FORMAT = 2
DESCRIPTION = 'JSON envelope in the stream field "rec"'


def encode(record):
    """record (dict) -> fields of a stream entry"""
    envelope = {
        "schema": FORMAT,
        "delivery": {
            "id": record["delivery_id"],
            "hook": record["hook_id"],
            "event": record["event"],
            "response": {"status": record["status"], "duration_ms": record["duration_ms"]},
            "delivered_at": record["delivered_at"],
            "payload_sha256": record["payload_sha256"],
        },
    }
    return {"rec": json.dumps(envelope, separators=(",", ":"))}


def decode(fields):
    """fields of a stream entry -> record (dict), or None when the entry is not a delivery record"""
    raw = fields.get("rec")
    if raw is None:
        return None
    try:
        d = json.loads(raw)["delivery"]
        return {
            "delivery_id": d["id"],
            "hook_id": d["hook"],
            "event": d["event"],
            "status": int(d["response"]["status"]),
            "duration_ms": int(d["response"]["duration_ms"]),
            "delivered_at": d["delivered_at"],
            "payload_sha256": d["payload_sha256"],
        }
    except (KeyError, TypeError, ValueError):
        return None
