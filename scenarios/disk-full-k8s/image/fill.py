#!/usr/bin/env python3
"""break helper (never mentioned in the brief): the table files get their age, then months of binlogs arrive at once
and fill the volume to ENOSPC."""
import errno
import os
import time

DATA = os.environ.get("DATADIR", "/var/lib/mysql")

# The story: this instance has been running for 240 days, and its table files look that old. The grader relies on it:
# a data directory re-initialized after the pod was deleted has brand new files.
aged = time.time() - 240 * 86400
for sub in ("mysql", "wordpress"):
    d = os.path.join(DATA, sub)
    for f in os.listdir(d):
        os.utime(os.path.join(d, f), (aged, aged))

idx_path = os.path.join(DATA, "binlog.index")
names = [l.strip() for l in open(idx_path) if l.strip()]
n = int(names[-1].split(".")[-1]) if names else 0
made = 0
old = time.time() - 40 * 86400
while True:
    n += 1
    name = f"binlog.{n:06d}"
    path = os.path.join(DATA, name)
    try:
        with open(path, "wb") as fh:
            fh.write(b"\1" * (4 * 1024 * 1024))
        names.append(name)
        made += 1
        os.utime(path, (old + made * 3600, old + made * 3600))
    except OSError as e:
        if e.errno == errno.ENOSPC:
            names.append(name)  # the half-written file stays, like a real crash mid-write
            break
        raise
with open(idx_path, "w") as fh:
    fh.write("".join(x + "\n" for x in names))
print(f"fill: {made} binlogs written, volume full")
