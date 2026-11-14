"""Background jobs of the security alerts service. Loaded by jobrunner (see `app:` in /etc/jobrunner/jobrunner.yml).

QUEUES  the queues this application declares, in the order jobrunner polls them
JOBS    job class -> function(job, ctx)

A function that returns is done. Any exception sends the job back to its queue; jobrunner.Drop discards it.
"""
import os
import random
import sys
import time

import pymysql

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import queues  # noqa: E402

QUEUES = queues.ALL


class Drop(Exception):
    """Replaced by jobrunner's own Drop when the module is loaded."""


def _db(ctx):
    cfg = ctx.settings["database"]
    return pymysql.connect(
        host=cfg.get("host", "127.0.0.1"),
        port=int(cfg.get("port", 3306)),
        user=cfg["user"],
        password=cfg["password"],
        database=cfg.get("name", "secalerts"),
        connect_timeout=3,
        read_timeout=20,
        write_timeout=20,
        charset="utf8mb4",
        autocommit=False,
    )


def advisory_repo_match(job, ctx):
    """One repository against one advisory: does the repository use an affected version, and if so, open an alert.

    The whole job is one database transaction: the advisory is read, the dependency graph of the repository is
    resolved against the affected version ranges, the alert is written.
    """
    advisory_id = int(job["args"]["advisory"])
    repo_id = int(job["args"]["repo"])
    conn = _db(ctx)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT severity FROM advisories WHERE id = %s", (advisory_id,))
            row = cur.fetchone()
            if row is None:
                raise Drop("advisory %d does not exist" % advisory_id)
            # the dependency graph of the repository: manifests, lock files, transitive dependencies.
            # On this host the graph service is not reachable, the time it takes is reproduced as is.
            time.sleep(random.uniform(3.0, 6.0))
            cur.execute(
                "INSERT INTO alerts (advisory_id, repo_id, state, severity, created_at, updated_at) "
                "VALUES (%s, %s, 'open', %s, NOW(), NOW()) ON DUPLICATE KEY UPDATE updated_at = updated_at",
                (advisory_id, repo_id, row[0]),
            )
        conn.commit()
    finally:
        conn.close()
    ctx.enqueue(queues.MAILERS, "AlertMail", advisory=advisory_id, repo=repo_id)


def alert_mail(job, ctx):
    """Tell the administrators of the repository about the new alert (handed to the mail relay)."""
    time.sleep(random.uniform(0.1, 0.25))


def webhook_delivery(job, ctx):
    time.sleep(random.uniform(0.1, 0.3))


def alert_export(job, ctx):
    time.sleep(random.uniform(0.5, 1.5))


JOBS = {
    "AdvisoryRepoMatch": advisory_repo_match,
    "AlertMail": alert_mail,
    "WebhookDelivery": webhook_delivery,
    "AlertExport": alert_export,
}
