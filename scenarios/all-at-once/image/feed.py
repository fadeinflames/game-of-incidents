#!/usr/bin/env python3
"""advisory-feed: publishes security advisories.

An advisory arrives from the advisory database (a file in /var/spool/advisory-feed/incoming). Publishing it means:
record it in the table `advisories`, then queue one AdvisoryRepoMatch job per repository that depends on the affected
package, then mark the advisory as fanned out. The jobs are executed by jobrunner.
"""
import glob
import json
import os
import random
import sys
import time

import pymysql
import redis

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import queues  # noqa: E402

DB = dict(
    host=os.environ.get("DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("DB_PORT", "3306")),
    user=os.environ["FEED_DB_USER"],
    password=os.environ["FEED_DB_PASSWORD"],
    database=os.environ.get("DB_NAME", "secalerts"),
    connect_timeout=3,
    read_timeout=10,
    write_timeout=10,
    charset="utf8mb4",
)
SPOOL = "/var/spool/advisory-feed"
REPOS = 60000
PACKAGES = ["quillmark", "tarnish-http", "pelican-json", "bramble-auth", "kestrel-ws", "thimble-zip", "cobble-csv",
            "harbor-pool", "wicker-xml", "ember-cron", "sorrel-tpl", "marlin-sql", "pumice-img", "nettle-jwt",
            "osier-cfg", "tansy-mail", "fennel-rate", "larch-tar", "ossifrage", "lantern-log"]
ECOSYSTEMS = ["npm", "pip", "maven", "rubygems"]
SEVERITIES = ["low", "moderate", "moderate", "high", "high", "critical"]

R = redis.Redis(host=os.environ.get("REDIS_HOST", "127.0.0.1"), port=int(os.environ.get("REDIS_PORT", "6379")),
                socket_timeout=5, socket_connect_timeout=3, decode_responses=True)


def log(msg):
    print("%s advisory-feed: %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg), flush=True)


def in_db(what, work):
    """Run work(cursor) in a transaction. The feed must not lose an advisory: it tries until the database takes it."""
    attempt = 0
    while True:
        attempt += 1
        try:
            conn = pymysql.connect(**DB)
            try:
                with conn.cursor() as cur:
                    result = work(cur)
                conn.commit()
                if attempt > 1:
                    log("%s: done on attempt %d" % (what, attempt))
                return result
            finally:
                conn.close()
        except pymysql.MySQLError as e:
            if attempt <= 3 or attempt % 10 == 0:
                log("%s: database error, attempt %d: %s; trying again in 2 s" % (what, attempt, " ".join(str(e).split())))
            time.sleep(2)


def push(jobs_by_queue):
    for name, jobs in jobs_by_queue.items():
        for start in range(0, len(jobs), 1000):
            while True:
                try:
                    R.lpush(name, *jobs[start:start + 1000])
                    break
                except redis.RedisError as e:
                    log("redis error while queueing jobs on %s: %s; trying again in 2 s" % (name, " ".join(str(e).split())))
                    time.sleep(2)


def publish(adv, repos):
    def record(cur):
        cur.execute("INSERT INTO advisories (package, ecosystem, severity, summary, affected_repos, published_at) "
                    "VALUES (%s, %s, %s, %s, 0, NOW())", (adv["package"], adv["ecosystem"], adv["severity"], adv["summary"]))
        return cur.lastrowid
    advisory_id = in_db("record advisory for %s" % adv["package"], record)
    jobs = {queues.FANOUT: [], queues.FANOUT_BULK: []}
    for repo in repos:
        name = queues.fanout_queue(repo)
        jobs[name].append(queues.envelope("AdvisoryRepoMatch", name, advisory=advisory_id, repo=repo))
    push(jobs)

    def mark(cur):
        cur.execute("UPDATE advisories SET affected_repos = %s, fanned_out_at = NOW() WHERE id = %s", (len(repos), advisory_id))
    in_db("mark advisory %d as fanned out" % advisory_id, mark)
    log("published advisory %d: package=%s ecosystem=%s severity=%s affected_repos=%d; queued %s=%d %s=%d" % (
        advisory_id, adv["package"], adv["ecosystem"], adv["severity"], len(repos),
        queues.FANOUT, len(jobs[queues.FANOUT]), queues.FANOUT_BULK, len(jobs[queues.FANOUT_BULK])))


def from_spool():
    for path in sorted(glob.glob(os.path.join(SPOOL, "incoming", "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            first, count = int(doc["repos"]["from"]), int(doc["repos"]["count"])
            adv = {k: str(doc[k]) for k in ("package", "ecosystem", "severity", "summary")}
        except Exception as e:  # noqa: BLE001
            log("cannot read %s: %s; moved to %s/rejected" % (path, e, SPOOL))
            os.replace(path, os.path.join(SPOOL, "rejected", os.path.basename(path)))
            continue
        log("advisory database: new advisory for %s (%s), %d repositories depend on the affected versions" % (adv["package"], adv["ecosystem"], count))
        os.replace(path, os.path.join(SPOOL, "published", os.path.basename(path)))
        publish(adv, list(range(first, first + count)))


def routine():
    package = random.choice(PACKAGES[:-1])
    adv = {"package": package, "ecosystem": random.choice(ECOSYSTEMS), "severity": random.choice(SEVERITIES),
           "summary": "Vulnerability in %s: upgrade to the patched release" % package}
    publish(adv, random.sample(range(1, REPOS + 1), random.randint(8, 24)))


def main():
    for sub in ("incoming", "published", "rejected"):
        os.makedirs(os.path.join(SPOOL, sub), exist_ok=True)
    log("started: watching %s/incoming, queues %s and %s" % (SPOOL, queues.FANOUT, queues.FANOUT_BULK))
    next_routine = time.monotonic() + random.uniform(20, 40)
    while True:
        from_spool()
        if time.monotonic() >= next_routine:
            routine()
            next_routine = time.monotonic() + random.uniform(60, 120)
        time.sleep(1)


if __name__ == "__main__":
    main()
