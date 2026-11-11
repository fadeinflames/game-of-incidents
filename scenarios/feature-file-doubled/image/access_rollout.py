#!/usr/bin/env python3
"""access-rollout: applies an access change to the analytics cluster node by node.

The change gives the service accounts explicit grants on the shard tables (so that queries are attributed to the account
that runs them). The plan is a state file: a ticket and the stages with their delays. Applied stages are re-checked on
every pass and re-applied if somebody reverted them.
"""
import configparser
import json
import os
import time

import psycopg2

CONF = "/etc/access-rollout/rollout.conf"
STATE = "/var/lib/access-rollout/state.json"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} access-rollout: {msg}", flush=True)


def read_conf():
    cp = configparser.ConfigParser()
    cp.read(CONF)
    nodes = {k: v for k, v in cp["nodes"].items()}
    roles = [r.strip() for r in cp.get("change", "roles").split(",") if r.strip()]
    return {"nodes": nodes, "roles": roles, "schema": cp.get("change", "schema"), "probe_table": cp.get("change", "probe_table")}


def connect(dbname):
    conn = psycopg2.connect(dbname=dbname, host="/var/run/postgresql", connect_timeout=3)
    conn.autocommit = True
    return conn


def granted(cur, conf):
    for role in conf["roles"]:
        cur.execute("SELECT has_table_privilege(%s, %s, 'SELECT')", (role, f"{conf['schema']}.{conf['probe_table']}"))
        if not cur.fetchone()[0]:
            return False
    return True


def apply(cur, conf):
    roles = ", ".join(conf["roles"])
    cur.execute(f"GRANT USAGE ON SCHEMA {conf['schema']} TO {roles}")
    cur.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA {conf['schema']} TO {roles}")


def main():
    conf = read_conf()
    log("started, waiting for a plan")
    announced = set()
    applied = set()
    while True:
        time.sleep(3)
        if not os.path.exists(STATE):
            continue
        try:
            with open(STATE, encoding="utf-8") as f:
                plan = json.load(f)
        except (OSError, ValueError) as e:
            log(f"cannot read {STATE}: {e}")
            continue
        ticket = plan.get("ticket", "?")
        stages = plan.get("stages", [])
        elapsed = time.time() - plan.get("started_at", time.time())
        for i, stage in enumerate(stages, 1):
            node = stage["node"]
            label = f"{ticket} stage {i}/{len(stages)} node {node}"
            if elapsed < stage.get("after_sec", 0):
                if label not in announced:
                    announced.add(label)
                    log(f"{label}: scheduled in {int(stage['after_sec'] - elapsed)}s")
                continue
            try:
                conn = connect(conf["nodes"][node])
                try:
                    with conn.cursor() as cur:
                        if granted(cur, conf):
                            applied.add(label)
                            continue
                        apply(cur, conf)
                finally:
                    conn.close()
            except Exception as e:  # noqa: BLE001  retried on the next pass
                log(f"{label}: FAILED: {str(e).strip()}")
                continue
            roles = ", ".join(conf["roles"])
            if label in applied:
                log(f"{label}: drift detected, grants re-applied")
            else:
                applied.add(label)
                log(f"{label}: applied: GRANT USAGE ON SCHEMA {conf['schema']}, SELECT ON ALL TABLES IN SCHEMA {conf['schema']} TO {roles}")


if __name__ == "__main__":
    main()
