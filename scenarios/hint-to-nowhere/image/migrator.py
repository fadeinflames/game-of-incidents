#!/usr/bin/env python3
"""migrator: applies an approved schema change to the shards one at a time.

A change is a plan file /var/lib/migrator/changes/<id>.json: the shards in order, the statements, and the soak time
the runner waits after a shard before it touches the next one. Progress is kept in <id>.state next to the plan, so a
restart of the service continues where it stopped.

The operator controls the runner with migratectl, which only creates and removes flag files:
  /var/lib/migrator/PAUSE     while it exists nothing is executed
  /var/lib/migrator/PROCEED   do not wait out the rest of the soak, process the next shard now (consumed by the runner)
"""
import glob
import json
import os
import time

import pymysql

HOME = "/var/lib/migrator"
CHANGES = HOME + "/changes"
PAUSE = HOME + "/PAUSE"
PROCEED = HOME + "/PROCEED"
RETRY_SEC = 30
DB = dict(
    host=os.environ.get("DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("DB_PORT", "3306")),
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    connect_timeout=5,
    charset="utf8mb4",
)

rejected = set()
was_paused = False


def iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def log(msg):
    print(f"{iso()} migrator: {msg}", flush=True)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(plan, state):
    path = f"{CHANGES}/{plan['id']}.state"
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)
        f.write("\n")
    os.replace(path + ".tmp", path)


def active_change():
    """The oldest plan that is not completed yet, with its state (None for a plan seen for the first time)."""
    for path in sorted(glob.glob(CHANGES + "/*.json")):
        try:
            plan = read_json(path)
            if not (plan["id"] and plan["shards"] and plan["statements"] and int(plan["soak_sec"]) >= 0):
                raise ValueError("id, shards, statements and soak_sec are required")
        except (OSError, ValueError, KeyError, TypeError) as e:
            if path not in rejected:
                rejected.add(path)
                log(f"plan {path} is rejected: {e}")
            continue
        try:
            state = read_json(f"{CHANGES}/{plan['id']}.state")
        except FileNotFoundError:
            state = None
        except (OSError, ValueError) as e:
            if path not in rejected:
                rejected.add(path)
                log(f"{plan['id']}: the state file is unreadable ({e}), the change is left alone")
            continue
        if state is None or not state.get("completed_at"):
            return plan, state
    return None, None


def run_shard(plan, shard):
    conn = pymysql.connect(database=shard, autocommit=True, **DB)
    try:
        with conn.cursor() as cur:
            for sql in plan["statements"]:
                log(f"{plan['id']} {shard}: {sql}")
                started = time.monotonic()
                cur.execute(sql)
                log(f"{plan['id']} {shard}: ok ({time.monotonic() - started:.2f}s)")
    finally:
        conn.close()


def tick():
    global was_paused
    plan, state = active_change()
    if plan is None:
        if os.path.exists(PROCEED):
            os.remove(PROCEED)
        return
    cid, shards = plan["id"], plan["shards"]
    if state is None:
        state = {"id": cid, "accepted_at": iso(), "done": {}, "next_at": 0, "completed_at": None}
        log(f"{cid} accepted: \"{plan.get('title', '')}\", shards {' -> '.join(shards)}, "
            f"soak {plan['soak_sec']}s between shards")
        save_state(plan, state)
    pending = [s for s in shards if s not in state["done"]]
    if not pending:
        state["completed_at"] = iso()
        save_state(plan, state)
        log(f"{cid}: completed on {len(shards)} of {len(shards)} shards")
        return

    paused = os.path.exists(PAUSE)
    if paused != was_paused:
        was_paused = paused
        log(f"{cid}: paused by the operator, {pending[0]} is not touched" if paused else f"{cid}: resumed by the operator")
    if paused:
        return

    now = time.time()
    proceed = os.path.exists(PROCEED)
    if now < state["next_at"] and not proceed:
        return
    if proceed:
        os.remove(PROCEED)
        if now < state["next_at"]:
            log(f"{cid}: the operator skipped the rest of the soak before {pending[0]}")

    shard = pending[0]
    try:
        run_shard(plan, shard)
    except pymysql.MySQLError as e:
        state["next_at"] = time.time() + RETRY_SEC
        save_state(plan, state)
        log(f"{cid} {shard}: FAILED, {e}; the next attempt in {RETRY_SEC}s")
        return
    state["done"][shard] = iso()
    left = [s for s in shards if s not in state["done"]]
    if left:
        state["next_at"] = time.time() + int(plan["soak_sec"])
        log(f"{cid} {shard}: done ({len(state['done'])} of {len(shards)} shards); soak {plan['soak_sec']}s, "
            f"{left[0]} not before {iso(state['next_at'])}")
    else:
        state["completed_at"] = iso()
        log(f"{cid} {shard}: done ({len(shards)} of {len(shards)} shards)")
        log(f"{cid}: completed on {len(shards)} of {len(shards)} shards")
    save_state(plan, state)


def main():
    log("started, watching " + CHANGES)
    while True:
        try:
            tick()
        except Exception as e:  # noqa: BLE001  the runner must survive anything and say what happened
            log(f"unexpected error: {e!r}")
            time.sleep(5)
        time.sleep(1)


if __name__ == "__main__":
    main()
