#!/usr/bin/env python3
"""The developers of the stand: every couple of seconds somebody opens a merge request in one of the code repositories.
A request is a topic commit on top of main (refs/merge-requests/<id>/head) and a file in the queue of mergeq.

  loadgen.py           run forever
  loadgen.py seed N    build time: N requests, each with its merge commit, dated in the past
"""
import json
import os
import random
import subprocess
import sys
import time

ROOT = "/var/lib/git"
REPOS = ["web/storefront.git", "web/checkout.git", "platform/billing-api.git", "platform/deploy-tools.git",
         "mobile/app.git", "docs/handbook.git"]
STATE = "/var/lib/loadgen"
PENDING = "/var/spool/mergeq/pending"
PEOPLE = ["a.volkova", "d.sokolov", "m.ivanova", "p.orlov", "t.kuznetsova", "s.lebedev", "e.morozova", "k.novikov"]


def git(repo, *args, inp=None, env=None):
    p = subprocess.run(["/usr/bin/git", "-C", os.path.join(ROOT, repo)] + list(args), input=inp, capture_output=True,
                       env=env, timeout=120)
    if p.returncode != 0:
        raise RuntimeError("git %s: %s" % (args[0], p.stderr.decode(errors="replace")[:200]))
    return p.stdout.decode().strip()


def next_id():
    path = os.path.join(STATE, "next-id")
    try:
        with open(path) as f:
            n = int(f.read().strip())
    except (OSError, ValueError):
        n = 1
    with open(path + ".tmp", "w") as f:
        f.write("%d\n" % (n + 1))
    os.replace(path + ".tmp", path)
    return n


def open_request(rnd, when=None):
    """-> (id, repo, head commit)"""
    mr = next_id()
    repo = rnd.choice(REPOS)
    who = rnd.choice(PEOPLE)
    when = when or time.time()
    date = "%d +0000" % when
    env = dict(os.environ, GIT_INDEX_FILE=os.path.join(STATE, "index-%s" % repo.replace("/", "_")),
               GIT_AUTHOR_NAME=who, GIT_AUTHOR_EMAIL=who + "@example.test", GIT_AUTHOR_DATE=date,
               GIT_COMMITTER_NAME=who, GIT_COMMITTER_EMAIL=who + "@example.test", GIT_COMMITTER_DATE=date)
    main = git(repo, "rev-parse", "--verify", "refs/heads/main")
    git(repo, "read-tree", main, env=env)
    path = "src/mod%02d/unit%03d.txt" % (rnd.randrange(12), rnd.randrange(120))
    text = "change of merge request !%d by %s\n" % (mr, who) + "".join("line %d of %s\n" % (i, path) for i in range(rnd.randrange(20, 60)))
    blob = git(repo, "hash-object", "-w", "--stdin", inp=text.encode())
    git(repo, "update-index", "--add", "--cacheinfo", "100644,%s,%s" % (blob, path), env=env)
    tree = git(repo, "write-tree", env=env)
    head = git(repo, "commit-tree", tree, "-p", main, "-m", "Update %s (!%d)" % (path, mr), env=env)
    git(repo, "update-ref", "refs/merge-requests/%d/head" % mr, head)
    return mr, repo, head, when


def enqueue(mr, repo, head, when):
    name = "%08d.mr" % mr
    tmp = os.path.join(PENDING, "." + name + ".tmp")
    with open(tmp, "w") as f:
        json.dump({"id": mr, "repo": repo, "head": head, "target": "main", "created": when}, f)
    os.chmod(tmp, 0o664)
    os.replace(tmp, os.path.join(PENDING, name))


def seed(count):
    """history for the image: requests of the last days, already merged"""
    rnd = random.Random(7)
    t = 1794000000
    for _ in range(count):
        t += rnd.randrange(600, 5400)
        mr, repo, head, when = open_request(rnd, when=t)
        date = "%d +0000" % (t + 1)
        env = dict(os.environ, GIT_AUTHOR_NAME="gitstored", GIT_AUTHOR_EMAIL="gitstored@git-03.internal", GIT_AUTHOR_DATE=date,  # secret-scan: allow (a made-up address inside the stand)
                   GIT_COMMITTER_NAME="gitstored", GIT_COMMITTER_EMAIL="gitstored@git-03.internal", GIT_COMMITTER_DATE=date)  # secret-scan: allow
        main = git(repo, "rev-parse", "--verify", "refs/heads/main")
        tree = git(repo, "merge-tree", "--write-tree", main, head).split()[0]
        merge = git(repo, "commit-tree", tree, "-p", main, "-p", head, "-m", "Merge request !%d into main" % mr, env=env)
        git(repo, "update-ref", "refs/merge-requests/%d/merge" % mr, merge)


def main():
    rnd = random.Random()
    while True:
        t0 = time.time()
        try:
            enqueue(*open_request(rnd))
        except Exception as e:
            sys.stderr.write("loadgen: %s\n" % e)
        time.sleep(max(0.2, rnd.uniform(1.5, 2.5) - (time.time() - t0)))


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "seed":
        seed(int(sys.argv[2]))
    else:
        main()
