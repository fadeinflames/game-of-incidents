#!/usr/bin/env python3
"""tablemover: moves a table to another database cluster while the application keeps writing to it.

How it works
  1. initial copy: the rows of the source table are copied to the target in chunks, in primary key order;
  2. tailing: triggers on the source table write every INSERT and DELETE into the change log table
     (_tablemover_changes); the applier reads the log in order and repeats each change on the target.

The applier is one ordered stream: APPLY_BATCH changes per tick, no parallel apply. Its position ("applied seq") is
committed on the target in the same transaction as the changes, so a restart continues exactly where the previous
run stopped. The target is therefore the source as it was at "applied seq"; everything after that is still in the
change log.

After the copy the apply is strict: an INSERT of a row that already exists on the target, or a DELETE of a row that
is not there, stops the job with an error and waits for the operator (repair the target, then `tablemover resume`).

tablemover does not switch the application. Which cluster serves reads and writes is the application's own routing.

Usage:
  tablemover status               the job, its position in the change log, backlog and lag
  tablemover pause | resume       stop / continue applying (resume also clears an error)
  tablemover reseed --start-over  throw the copy away and start from the beginning: the target table is emptied
                                  and copied again (a full copy of this table takes more than an hour)
  tablemover daemon               the service itself (started by the init script)
"""
import collections
import configparser
import json
import re
import sys
import time

import pymysql
import pymysql.cursors

CONF = "/etc/tablemover/job.conf"
TICK_SEC = 1.0
APPLY_BATCH = 10      # changes applied per tick, in one transaction
COPY_CHUNK = 50       # rows copied per tick during the initial copy
PURGE_KEEP = 2000     # applied changes kept in the change log before they are purged
REPORT_SEC = 30
CHANGES = "_tablemover_changes"
JOBS = "_tablemover_job"
JOB_FIELDS = ("job, generation, phase, state, applied_seq, applied_change_ts, copy_pos, copy_upto, tolerant_until_seq, "
              "copy_started_at, copy_done_at, rate_in, rate_out, last_error, heartbeat_at")
IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


class ApplyError(Exception):
    def __init__(self, seq, text):
        super().__init__(text)
        self.seq = seq
        self.text = text


class Moved(Exception):
    """the job row was changed by somebody else between the read and the commit"""


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} tablemover: {msg}", flush=True)


def hms(seconds):
    seconds = max(0, int(seconds))
    return "%02d:%02d:%02d" % (seconds // 3600, seconds % 3600 // 60, seconds % 60)


def load_conf():
    cp = configparser.ConfigParser()
    try:
        with open(CONF, encoding="utf-8") as f:
            cp.read_file(f)
    except OSError as e:
        sys.exit(f"tablemover: cannot read {CONF}: {e}")
    table = cp["job"]["table"]
    if not IDENT.match(table):
        sys.exit(f"tablemover: bad table name in {CONF}")
    return cp


def connect(cp, side):
    s = cp[side]
    conn = pymysql.connect(host=s["host"], port=int(s["port"]), user=s["user"], password=s["password"],
                           database=s["database"], connect_timeout=3, read_timeout=30, write_timeout=30,
                           charset="utf8mb4", autocommit=False)
    with conn.cursor() as cur:
        cur.execute("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
        cur.execute("SET SESSION innodb_lock_wait_timeout = 10")
    conn.commit()
    return conn


def get_job(dst, name):
    with dst.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(f"SELECT {JOB_FIELDS} FROM {JOBS} WHERE job = %s", (name,))
        row = cur.fetchone()
    dst.commit()
    return row


def head_seq(src):
    with src.cursor() as cur:
        cur.execute(f"SELECT COALESCE(MAX(seq), 0) FROM {CHANGES}")
        head = cur.fetchone()[0]
    src.commit()
    return int(head)


def oldest_pending(src, applied):
    """(seconds since the oldest change that is not applied yet was made, its time); (0, None) when nothing waits"""
    with src.cursor() as cur:
        cur.execute(f"SELECT TIMESTAMPDIFF(SECOND, ts, NOW()), ts FROM {CHANGES} WHERE seq > %s ORDER BY seq LIMIT 1", (applied,))
        row = cur.fetchone()
    src.commit()
    return (max(0, int(row[0])), row[1]) if row else (0, None)


def apply_changes(dst, table, job, rows):
    """One transaction on the target: the changes and the new position. The caller rolls back on an exception."""
    with dst.cursor() as cur:
        for seq, _ts, op, row_id, row_data in rows:
            tolerant = seq <= job["tolerant_until_seq"]
            what = {"I": "INSERT", "D": "DELETE"}.get(op, op)
            try:
                if op == "I":
                    data = json.loads(row_data)
                    cols = ["id"] + list(data)
                    if not all(IDENT.match(c) for c in cols):
                        raise ApplyError(seq, f"INSERT id={row_id}: bad column name in the change log")
                    verb = "REPLACE" if tolerant else "INSERT"
                    cur.execute(f"{verb} INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
                                [row_id] + list(data.values()))
                elif op == "D":
                    n = cur.execute(f"DELETE FROM {table} WHERE id = %s", (row_id,))
                    if n != 1 and not tolerant:
                        raise ApplyError(seq, f"DELETE id={row_id}: the row does not exist on the target")
                else:
                    raise ApplyError(seq, f"unknown operation {op!r} for id={row_id}")
            except (pymysql.err.IntegrityError, pymysql.err.DataError, pymysql.err.ProgrammingError, ValueError) as e:
                raise ApplyError(seq, f"{what} id={row_id}: {e}") from None
        last = rows[-1]
        n = cur.execute(f"UPDATE {JOBS} SET applied_seq = %s, applied_change_ts = %s "
                        "WHERE job = %s AND generation = %s AND applied_seq = %s",
                        (last[0], last[1], job["job"], job["generation"], job["applied_seq"]))
        if n != 1:
            raise Moved()
    dst.commit()
    job["applied_seq"] = last[0]


class Daemon:
    def __init__(self, cp):
        self.cp = cp
        self.name = cp["job"]["name"]
        self.table = cp["job"]["table"]
        self.src = None
        self.dst = None
        self.samples = collections.deque()
        self.last_report = 0.0
        self.last_state = None
        self.ticks = 0

    def close(self):
        for conn in (self.src, self.dst):
            try:
                if conn is not None:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass
        self.src = self.dst = None

    def run(self):
        log(f"service started: job {self.name}, table {self.table}, "
            f"{self.cp['source']['name']} ({self.cp['source']['host']}:{self.cp['source']['port']}) -> "
            f"{self.cp['target']['name']} ({self.cp['target']['host']}:{self.cp['target']['port']})")
        next_tick = time.monotonic()
        failing = False
        while True:
            try:
                if self.src is None:
                    self.src = connect(self.cp, "source")
                if self.dst is None:
                    self.dst = connect(self.cp, "target")
                self.tick()
                if failing:
                    log("database connections are back")
                    failing = False
            except pymysql.MySQLError as e:
                if not failing:
                    log(f"database error: {e}; reconnecting every second")
                failing = True
                self.close()
            next_tick += TICK_SEC
            delay = next_tick - time.monotonic()
            if delay < -5:
                next_tick = time.monotonic()
            elif delay > 0:
                time.sleep(delay)

    def tick(self):
        self.ticks += 1
        job = get_job(self.dst, self.name)
        if job is None:
            if self.last_state != "missing":
                log(f"ERROR no row for job {self.name} in {JOBS} on the target")
                self.last_state = "missing"
            return
        key = (job["generation"], job["phase"], job["state"])
        if self.last_state is not None and key != self.last_state:
            log(f"job is now: generation {job['generation']}, phase {job['phase']}, state {job['state']}")
        self.last_state = key

        if job["state"] == "running":
            if job["phase"] == "copying":
                self.copy_step(job)
            else:
                self.tail_step(job)

        job = get_job(self.dst, self.name) or job
        head = max(head_seq(self.src), int(job["applied_seq"]))
        now = time.monotonic()
        self.samples.append((now, head, int(job["applied_seq"])))
        while len(self.samples) > 2 and now - self.samples[0][0] > 60:
            self.samples.popleft()
        t0, h0, a0 = self.samples[0]
        span = max(now - t0, 1.0)
        rate_in = (head - h0) / span
        rate_out = max(0, int(job["applied_seq"]) - a0) / span
        with self.dst.cursor() as cur:
            cur.execute(f"UPDATE {JOBS} SET heartbeat_at = NOW(), rate_in = %s, rate_out = %s WHERE job = %s",
                        (round(rate_in, 1), round(rate_out, 1), self.name))
        self.dst.commit()

        if now - self.last_report >= REPORT_SEC:
            self.last_report = now
            if job["phase"] == "copying":
                log(f"initial copy: {job['copy_pos']} of {job['copy_upto'] or '?'} (by id), state {job['state']}")
            else:
                lag, _ts = oldest_pending(self.src, job["applied_seq"])
                log(f"tailing: applied seq {job['applied_seq']}, backlog {max(0, head - int(job['applied_seq']))} changes, "
                    f"lag {hms(lag)}, in {rate_in:.1f}/s, out {rate_out:.1f}/s, state {job['state']}")
        if self.ticks % 60 == 0 and job["phase"] == "tailing":
            with self.src.cursor() as cur:
                cur.execute(f"DELETE FROM {CHANGES} WHERE seq <= %s LIMIT 5000", (int(job["applied_seq"]) - PURGE_KEEP,))
            self.src.commit()

    def tail_step(self, job):
        with self.src.cursor() as cur:
            # a locking read: a change that is still inside an open transaction is waited for, never skipped
            cur.execute(f"SELECT seq, ts, op, row_id, row_data FROM {CHANGES} WHERE seq > %s ORDER BY seq LIMIT %s "
                        "LOCK IN SHARE MODE", (job["applied_seq"], APPLY_BATCH))
            rows = cur.fetchall()
        self.src.commit()
        if not rows:
            return
        try:
            apply_changes(self.dst, self.table, job, rows)
            return
        except Moved:
            self.dst.rollback()
            return
        except ApplyError:
            self.dst.rollback()
        # one by one: keep what applies, stop at the change that does not
        for row in rows:
            try:
                apply_changes(self.dst, self.table, job, [row])
            except Moved:
                self.dst.rollback()
                return
            except ApplyError as e:
                self.dst.rollback()
                text = f"change seq {e.seq}: {e.text}"
                with self.dst.cursor() as cur:
                    cur.execute(f"UPDATE {JOBS} SET state = 'error', last_error = %s WHERE job = %s AND generation = %s",
                                (text, job["job"], job["generation"]))
                self.dst.commit()
                log(f"ERROR apply stopped at {text}. Repair the target table, then run: tablemover resume")
                return

    def copy_step(self, job):
        table = self.table
        if job["copy_upto"] is None:
            # the change log position is taken first: whatever happens to the source after it is replayed after the copy
            head = head_seq(self.src)
            with self.src.cursor() as cur:
                cur.execute(f"SELECT COALESCE(MAX(id), 0), COUNT(*) FROM {table}")
                upto, total = cur.fetchone()
            self.src.commit()
            with self.dst.cursor() as cur:
                cur.execute(f"DELETE FROM {table}")
                n = cur.execute(f"UPDATE {JOBS} SET copy_pos = 0, copy_upto = %s, applied_seq = %s, applied_change_ts = NULL, "
                                "copy_started_at = NOW(), copy_done_at = NULL WHERE job = %s AND generation = %s",
                                (upto, head, job["job"], job["generation"]))
            if n != 1:
                self.dst.rollback()
                return
            self.dst.commit()
            log(f"initial copy started: the target table is emptied, {total} rows up to id {upto} to copy, "
                f"{COPY_CHUNK} rows per second (about {hms(total / COPY_CHUNK)}); change log position {head}")
            return
        with self.src.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(f"SELECT * FROM {table} WHERE id > %s AND id <= %s ORDER BY id LIMIT %s",
                        (job["copy_pos"], job["copy_upto"], COPY_CHUNK))
            rows = cur.fetchall()
        self.src.commit()
        if rows:
            cols = list(rows[0])
            with self.dst.cursor() as cur:
                cur.executemany(f"REPLACE INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
                                [tuple(r[c] for c in cols) for r in rows])
                n = cur.execute(f"UPDATE {JOBS} SET copy_pos = %s WHERE job = %s AND generation = %s",
                                (rows[-1]["id"], job["job"], job["generation"]))
            if n != 1:
                self.dst.rollback()
                return
            self.dst.commit()
            return
        # the copy is over: changes made during it are replayed leniently, later ones strictly
        head = head_seq(self.src)
        with self.dst.cursor() as cur:
            cur.execute(f"UPDATE {JOBS} SET phase = 'tailing', copy_done_at = NOW(), tolerant_until_seq = %s "
                        "WHERE job = %s AND generation = %s", (head, job["job"], job["generation"]))
        self.dst.commit()
        log(f"initial copy finished; tailing the change log from seq {job['applied_seq']}")


def cmd_status(cp):
    name = cp["job"]["name"]
    try:
        dst = connect(cp, "target")
    except pymysql.MySQLError as e:
        sys.exit(f"tablemover: the target ({cp['target']['name']}) does not answer: {e}")
    job = get_job(dst, name)
    if job is None:
        sys.exit(f"tablemover: no job {name} on the target")
    src_line = f"{cp['source']['name']} {cp['source']['host']}:{cp['source']['port']}  {cp['source']['database']}.{cp['job']['table']}"
    dst_line = f"{cp['target']['name']} {cp['target']['host']}:{cp['target']['port']}  {cp['target']['database']}.{cp['job']['table']}"
    out = [("job", f"{name} (generation {job['generation']})"), ("source", src_line), ("target", dst_line)]
    if job["phase"] == "copying":
        out.append(("phase", f"initial copy, started {job['copy_started_at'] or 'just now'} UTC: at id {job['copy_pos']} of {job['copy_upto'] or '?'}"))
    else:
        out.append(("phase", f"tailing the change log (initial copy finished {job['copy_done_at']} UTC)"))
    beat = job["heartbeat_at"]
    with dst.cursor() as cur:
        cur.execute("SELECT TIMESTAMPDIFF(SECOND, %s, NOW())", (beat,))
        age = cur.fetchone()[0]
    dst.commit()
    state = job["state"]
    if age is None or age > 15:
        state += f"  (the tablemover service is not running: last heartbeat {beat} UTC)"
    out.append(("state", state))
    try:
        src = connect(cp, "source")
        head = max(head_seq(src), int(job["applied_seq"]))
        lag, ts = oldest_pending(src, job["applied_seq"])
        backlog = max(0, head - int(job["applied_seq"]))
        out.append(("change log", f"head seq {head}, applied seq {job['applied_seq']}"))
        out.append(("backlog", f"{backlog} changes"))
        if job["phase"] == "tailing":
            out.append(("lag", f"{hms(lag)}" + (f"  (now applying changes made at {ts} UTC)" if ts else "  (nothing waits)")))
        out.append(("rate, 1 min", f"in {job['rate_in']}/s, out {job['rate_out']}/s"))
        src.close()
    except pymysql.MySQLError as e:
        out.append(("change log", f"the source ({cp['source']['name']}) does not answer: {e}"))
    out.append(("last error", job["last_error"] or "none"))
    dst.close()
    for k, v in out:
        print(f"{k:<13}{v}")


def cmd_set_state(cp, action):
    name = cp["job"]["name"]
    dst = connect(cp, "target")
    with dst.cursor() as cur:
        if action == "pause":
            n = cur.execute(f"UPDATE {JOBS} SET state = 'paused' WHERE job = %s AND state = 'running'", (name,))
        else:
            n = cur.execute(f"UPDATE {JOBS} SET state = 'running', last_error = NULL WHERE job = %s AND state <> 'running'", (name,))
    dst.commit()
    job = get_job(dst, name)
    dst.close()
    print(f"job {name}: state {job['state']}" + ("" if n else " (nothing to change)"))


def cmd_reseed(cp, args):
    name = cp["job"]["name"]
    if "--start-over" not in args:
        sys.exit("tablemover: reseed empties the target table and copies it again from the beginning.\n"
                 "            Everything applied so far is thrown away; a full copy of this table takes more than an hour.\n"
                 "            If that is what you want: tablemover reseed --start-over")
    dst = connect(cp, "target")
    with dst.cursor() as cur:
        cur.execute(f"UPDATE {JOBS} SET generation = generation + 1, phase = 'copying', state = 'running', copy_pos = 0, "
                    "copy_upto = NULL, tolerant_until_seq = 0, last_error = NULL WHERE job = %s", (name,))
    dst.commit()
    job = get_job(dst, name)
    dst.close()
    print(f"job {name}: generation {job['generation']}, the initial copy starts over on the next tick of the service")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "help"
    if cmd in ("help", "-h", "--help"):
        print(__doc__.strip())
        return 0
    cp = load_conf()
    try:
        if cmd == "daemon":
            Daemon(cp).run()
        elif cmd == "status":
            cmd_status(cp)
        elif cmd in ("pause", "resume"):
            cmd_set_state(cp, cmd)
        elif cmd == "reseed":
            cmd_reseed(cp, args[1:])
        else:
            sys.exit(f"tablemover: unknown command {cmd!r}; try: tablemover help")
    except pymysql.MySQLError as e:
        sys.exit(f"tablemover: database error: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
