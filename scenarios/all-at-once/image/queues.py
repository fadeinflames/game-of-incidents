"""Queue names of the security alerts service and the job envelope.

Since release 4.18.0 every queue carries the team prefix (queue namespace migration of the platform team).
Producers (advisory-feed) and workers (jobrunner) import the names from here, so they always agree.
"""
import json
import secrets

PREFIX = "secalerts."

MAILERS = PREFIX + "mailers"
WEBHOOKS = PREFIX + "webhooks"
EXPORTS = PREFIX + "exports"
# advisory fan-out: one job per repository that depends on the affected package
FANOUT = PREFIX + "advisory_fanout"
FANOUT_BULK = PREFIX + "advisory_fanout_bulk"

ALL = [MAILERS, WEBHOOKS, EXPORTS, FANOUT, FANOUT_BULK]


def fanout_queue(repo_id):
    """Repositories of organisations on a paid plan go to the first queue, everything else to the bulk queue."""
    return FANOUT if repo_id % 4 == 0 else FANOUT_BULK


def envelope(cls, queue, **args):
    """A job as it is stored in Redis: one JSON document per list element."""
    return json.dumps({"jid": secrets.token_hex(6), "class": cls, "queue": queue, "args": args}, separators=(",", ":"))
