#!/usr/bin/env python3
"""mergeq: the merge request queue of this host.

Every open merge request needs a test-merge commit (target branch + head of the request): CI pipelines start from it.
New requests arrive as files in /var/spool/mergeq/pending. The worker takes them oldest first, asks gitstored
to create the merge commit and then triggers the pipeline. A request stays in the queue until its commit exists.

  mergeq.py daemon     the worker
  mergeq.py status     queue length, age of the oldest request, delays of the last five minutes
  mergeq.py list       the requests that wait
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

SPOOL = "/var/spool/mergeq"
PENDING = SPOOL + "/pending"
FAILED = SPOOL + "/failed"
DONE_LOG = "/var/log/mergeq/done.log"
PIPELINES_LOG = "/var/log/mergeq/pipelines.log"
STORAGE = "http://127.0.0.1:8075"
RETRY_SEC = 2.0

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def stamp(t=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def log(msg):
    sys.stdout.write("%s mergeq[%d]: %s\n" % (stamp(), os.getpid(), msg))
    sys.stdout.flush()


def pending():
    """the waiting requests, oldest first"""
    out = []
    try:
        names = sorted(n for n in os.listdir(PENDING) if n.endswith(".mr"))
    except OSError:
        return out
    for name in names:
        try:
            with open(os.path.join(PENDING, name)) as f:
                doc = json.load(f)
            doc["_file"] = os.path.join(PENDING, name)
            out.append(doc)
        except (OSError, ValueError):
            continue
    return out


def storage(path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(STORAGE + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def daemon():
    log("worker started; queue %s, storage %s" % (PENDING, STORAGE))
    last_complaint = 0.0
    while True:
        queue = pending()
        if not queue:
            time.sleep(0.5)
            continue
        for mr in queue:
            try:
                code, doc = storage("/v1/merge-commit", {"repo": mr["repo"], "mr": mr["id"], "head": mr["head"],
                                                         "target": mr.get("target", "main")})
            except Exception as e:
                # the storage does not answer: nothing is dropped, the queue waits
                now = time.time()
                if now - last_complaint >= 10:
                    left = pending()
                    oldest = now - left[0]["created"] if left else 0
                    reason = getattr(e, "reason", e)
                    log("storage %s unavailable (%s): %d merge requests wait, the oldest for %d s; retry every %d s"
                        % (STORAGE, reason, len(left), oldest, RETRY_SEC))
                    last_complaint = now
                time.sleep(RETRY_SEC)
                break
            now = time.time()
            delay = now - mr["created"]
            if code == 200:
                log("mr=%d repo=%s merge=%s delay=%.1fs" % (mr["id"], mr["repo"], doc.get("merge", "")[:12], delay))
                with open(DONE_LOG, "a") as f:
                    f.write("%s %.3f mr=%d repo=%s merge=%s delay=%.1f\n" % (stamp(now), now, mr["id"], mr["repo"], doc.get("merge", ""), delay))
                with open(PIPELINES_LOG, "a") as f:
                    f.write("%s pipeline for mr=%d (%s) triggered, it waited %.1f s for the merge commit\n"
                            % (stamp(now), mr["id"], mr["repo"], delay))
                os.unlink(mr["_file"])
            else:
                log("mr=%d repo=%s: the storage refused the merge commit: %d %s; moved to %s"
                    % (mr["id"], mr["repo"], code, doc.get("error", ""), FAILED))
                os.rename(mr["_file"], os.path.join(FAILED, os.path.basename(mr["_file"])))


def recent(window=300):
    out = []
    now = time.time()
    try:
        with open(DONE_LOG, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 200000))
            lines = f.read().decode(errors="replace").splitlines()
    except OSError:
        return out
    for line in lines:
        parts = line.split()
        try:
            t = float(parts[1])
            delay = float(parts[-1].split("=", 1)[1])
        except (IndexError, ValueError):
            continue
        if now - t <= window:
            out.append(delay)
    return out


def status():
    queue = pending()
    now = time.time()
    if queue:
        print("queue: %d merge requests wait for a merge commit, the oldest for %d s" % (len(queue), now - queue[0]["created"]))
    else:
        print("queue: empty")
    delays = sorted(recent())
    if delays:
        print("last 5 minutes: %d merge commits created; delay median %.1f s, max %.1f s"
              % (len(delays), delays[len(delays) // 2], delays[-1]))
    else:
        print("last 5 minutes: no merge commits created")
    try:
        code, doc = storage("/health", timeout=3)
        print("storage: %s answers, worker pid %s, up for %s s" % (STORAGE, doc.get("worker_pid"), doc.get("uptime_s")))
    except Exception as e:
        print("storage: %s does not answer (%s)" % (STORAGE, getattr(e, "reason", e)))


def listing():
    now = time.time()
    queue = pending()
    for mr in queue:
        print("mr=%-6d %-28s waits %4d s" % (mr["id"], mr["repo"], now - mr["created"]))
    print("%d merge requests wait" % len(queue))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "daemon":
        daemon()
    elif cmd == "status":
        status()
    elif cmd == "list":
        listing()
    else:
        sys.stderr.write("usage: mergeq {status|list}\n")
        sys.exit(2)
