#!/usr/bin/env python3
"""featuregen: builds the feature file for the bot-scoring module of the edge proxy.

Every cycle it asks one node of the analytics cluster (the nodes are used in turn) which feature columns exist,
writes the list to the features file and keeps a copy in the archive. The query lives in a file under /etc.
"""
import argparse
import configparser
import json
import os
import sys
import time

import psycopg2

CONF = "/etc/featuregen/featuregen.conf"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"{now()} featuregen: {msg}", flush=True)


def read_conf():
    cp = configparser.ConfigParser()
    if not cp.read(CONF):
        raise SystemExit(f"featuregen: cannot read {CONF}")
    main = cp["featuregen"]
    nodes = [n.strip() for n in main.get("nodes", "").split(",") if n.strip()]
    dsns = {}
    for n in nodes:
        section = f"node:{n}"
        if section not in cp or "dsn" not in cp[section]:
            raise SystemExit(f"featuregen: no [{section}] dsn in {CONF}")
        dsns[n] = cp[section]["dsn"]
    return {
        "interval": main.getint("interval_sec", 20),
        "query_file": main.get("query_file", "/etc/featuregen/query.sql"),
        "output": main.get("output", "/var/lib/edge/features/current.json"),
        "archive_dir": main.get("archive_dir", "/var/lib/edge/features/archive"),
        "archive_keep": main.getint("archive_keep", 40),
        "nodes": nodes,
        "dsns": dsns,
    }


def fetch_features(dsn, query_file):
    with open(query_file, encoding="utf-8") as f:
        sql = f.read()
    conn = psycopg2.connect(dsn, connect_timeout=3)
    try:
        conn.set_session(readonly=True, autocommit=True)
        with conn.cursor() as cur:
            cur.execute(sql)
            return [{"name": r[0], "type": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()


def write_atomic(path, doc):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)


def prune(archive_dir, keep):
    files = sorted(f for f in os.listdir(archive_dir) if f.startswith("features-") and f.endswith(".json"))
    for f in files[:-keep] if keep > 0 else files:
        try:
            os.unlink(os.path.join(archive_dir, f))
        except OSError:
            pass


def cycle(conf, node, version):
    features = fetch_features(conf["dsns"][node], conf["query_file"])
    doc = {"version": version, "generated_at": now(), "node": node, "features": features}
    os.makedirs(conf["archive_dir"], exist_ok=True)
    write_atomic(os.path.join(conf["archive_dir"], f"features-{version}.json"), doc)
    write_atomic(conf["output"], doc)
    prune(conf["archive_dir"], conf["archive_keep"])
    log(f"version={version} node={node} features={len(features)} -> {conf['output']}")


def main():
    ap = argparse.ArgumentParser(description="feature file generator for the edge proxy")
    ap.add_argument("--dry-run", action="store_true", help="query one node and print the counts, write nothing")
    ap.add_argument("--node", help="node name from the config (with --dry-run)")
    ap.add_argument("--dsn", help="connection string to use instead of a configured node (with --dry-run)")
    args = ap.parse_args()
    conf = read_conf()

    if args.dry_run:
        dsn = args.dsn or conf["dsns"].get(args.node or (conf["nodes"][0] if conf["nodes"] else ""))
        if not dsn:
            raise SystemExit("featuregen: --dry-run needs --node <name> or --dsn <dsn>")
        features = fetch_features(dsn, conf["query_file"])
        names = [f["name"] for f in features]
        print(json.dumps({"features": len(names), "unique": len(set(names))}))
        return

    if not conf["nodes"]:
        raise SystemExit("featuregen: no nodes configured")
    log(f"started, interval {conf['interval']}s, nodes {', '.join(conf['nodes'])}")
    n = 0
    while True:
        node = conf["nodes"][n % len(conf["nodes"])]
        try:
            cycle(conf, node, int(time.time()))
        except Exception as e:  # noqa: BLE001  the next cycle tries the next node
            log(f"node={node} FAILED: {str(e).strip()}")
        n += 1
        time.sleep(conf["interval"])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
