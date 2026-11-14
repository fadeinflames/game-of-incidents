"""Handoff format of a delivery record between the dispatcher (writes) and the recorder (reads).

Format 1: the record is the stream entry itself, one stream field per attribute.
"""
FORMAT = 1
DESCRIPTION = "flat stream fields"

FIELDS = ("delivery_id", "hook_id", "event", "status", "duration_ms", "delivered_at", "payload_sha256")


def encode(record):
    """record (dict) -> fields of a stream entry"""
    return {name: str(record[name]) for name in FIELDS}


def decode(fields):
    """fields of a stream entry -> record (dict), or None when the entry is not a delivery record"""
    if "delivery_id" not in fields:
        return None
    try:
        return {
            "delivery_id": fields["delivery_id"],
            "hook_id": fields["hook_id"],
            "event": fields["event"],
            "status": int(fields["status"]),
            "duration_ms": int(fields["duration_ms"]),
            "delivered_at": fields["delivered_at"],
            "payload_sha256": fields["payload_sha256"],
        }
    except (KeyError, ValueError):
        return None
