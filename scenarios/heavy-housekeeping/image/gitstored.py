#!/usr/bin/env python3
"""gitstored: the git storage service of this host.

Other services do not run git themselves: they ask gitstored over HTTP on 127.0.0.1:8075.

  gitstored.py master   starts one worker and starts a new one when the worker dies
  gitstored.py worker   allocates the object cache and serves the RPC

RPC:
  GET  /health            state of the worker
  POST /v1/merge-commit   {"repo": "group/name.git", "mr": 123, "head": "<commit>", "target": "main"}
                          creates the test-merge commit of a merge request and points
                          refs/merge-requests/<mr>/merge at it

Settings: /etc/gitstored/gitstored.conf
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/gitstored/gitstored.conf"
DEFAULTS = {"listen": "127.0.0.1:8075", "root": "/var/lib/git", "cache_mb": "332", "restart_delay": "90"}
REPO_RE = re.compile(r"^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*\.git$")
OID_RE = re.compile(r"^[0-9a-f]{40}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


def settings():
    conf = dict(DEFAULTS)
    try:
        with open(CONF) as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if "=" in line:
                    k, v = line.split("=", 1)
                    conf[k.strip()] = v.strip()
    except OSError:
        pass
    return conf


def log(msg):
    sys.stdout.write("%s gitstored[%d]: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), os.getpid(), msg))
    sys.stdout.flush()


# ---------------------------------------------------------------- master

def master():
    conf = settings()
    delay = max(1, int(conf["restart_delay"]))
    state = {"stop": False, "worker": 0}

    def on_term(signum, frame):
        state["stop"] = True
        if state["worker"]:
            try:
                os.kill(state["worker"], signal.SIGTERM)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    log("master: started; worker settings: listen %s, cache_mb %s, restart_delay %d s" % (conf["listen"], conf["cache_mb"], delay))
    while not state["stop"]:
        pid = os.fork()
        if pid == 0:
            os.execv(sys.executable, [sys.executable, "-u", os.path.abspath(__file__), "worker"])
        state["worker"] = pid
        born = time.time()
        log("master: worker %d started" % pid)
        _, status = os.waitpid(pid, 0)
        state["worker"] = 0
        life = int(time.time() - born)
        if state["stop"]:
            break
        if os.WIFSIGNALED(status):
            sig = os.WTERMSIG(status)
            try:
                name = signal.Signals(sig).name
            except ValueError:
                name = "?"
            how = "was killed by signal %d (%s)" % (sig, name)
        else:
            how = "exited with status %d" % os.WEXITSTATUS(status)
        log("master: worker %d %s after %d s; the RPC on %s is down; the next worker starts in %d s"
            % (pid, how, life, conf["listen"], delay))
        end = time.time() + delay
        while time.time() < end and not state["stop"]:
            time.sleep(0.5)
    log("master: stopped")


# ---------------------------------------------------------------- worker

class Worker:
    def __init__(self):
        self.conf = settings()
        self.root = self.conf["root"]
        self.cache_mb = int(self.conf["cache_mb"])
        self.started = time.time()
        self.requests = 0
        self.lock = threading.Lock()
        # the object cache is allocated in one piece when the worker starts
        self.cache = bytearray(self.cache_mb * 1024 * 1024)
        page = b"\x01"
        for off in range(0, len(self.cache), 4096):
            self.cache[off:off + 1] = page
        self.env = dict(os.environ, GIT_AUTHOR_NAME="gitstored", GIT_AUTHOR_EMAIL="gitstored@git-03.internal",  # secret-scan: allow (a made-up address inside the stand)
                        GIT_COMMITTER_NAME="gitstored", GIT_COMMITTER_EMAIL="gitstored@git-03.internal")  # secret-scan: allow

    def git(self, repo, *args):
        p = subprocess.run(["/usr/bin/git", "-C", os.path.join(self.root, repo)] + list(args), capture_output=True,
                           text=True, env=self.env, timeout=60)
        return p.returncode, p.stdout.strip(), p.stderr.strip()

    def merge_commit(self, doc):
        repo, mr, head, target = doc.get("repo", ""), doc.get("mr"), doc.get("head", ""), doc.get("target", "main")
        if not REPO_RE.match(repo) or not isinstance(mr, int) or not OID_RE.match(head) or not REF_RE.match(target):
            return 400, {"error": "bad request"}
        if not os.path.isdir(os.path.join(self.root, repo)):
            return 404, {"error": "no such repository"}
        rc, base, err = self.git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/%s^{commit}" % target)
        if rc != 0:
            return 422, {"error": "no such target branch: %s" % target}
        rc, out, err = self.git(repo, "merge-tree", "--write-tree", base, head)
        if rc == 1:
            return 409, {"error": "conflict"}
        if rc != 0:
            return 500, {"error": "git merge-tree: %s" % (err or out)[:200]}
        tree = out.split()[0]
        rc, commit, err = self.git(repo, "commit-tree", tree, "-p", base, "-p", head, "-m",
                                   "Merge request !%d into %s" % (mr, target))
        if rc != 0:
            return 500, {"error": "git commit-tree: %s" % err[:200]}
        rc, _, err = self.git(repo, "update-ref", "refs/merge-requests/%d/merge" % mr, commit)
        if rc != 0:
            return 500, {"error": "git update-ref: %s" % err[:200]}
        return 200, {"merge": commit, "base": base}


def make_handler(worker):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, fmt, *args):
            pass

        def reply(self, code, doc):
            body = json.dumps(doc).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"status": "ok", "worker_pid": os.getpid(), "uptime_s": int(time.time() - worker.started),
                                 "cache_mb": worker.cache_mb, "requests": worker.requests})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/v1/merge-commit":
                self.reply(404, {"error": "not found"})
                return
            t0 = time.time()
            try:
                doc = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            except ValueError:
                doc = {}
            try:
                code, out = worker.merge_commit(doc if isinstance(doc, dict) else {})
            except Exception as e:  # a failed git call must not take the worker down
                code, out = 500, {"error": str(e)[:200]}
            with worker.lock:
                worker.requests += 1
            log("merge-commit repo=%s mr=%s -> %d %s (%.3f s)" % (doc.get("repo"), doc.get("mr"), code,
                                                                 out.get("merge", out.get("error", ""))[:12], time.time() - t0))
            self.reply(code, out)

    return Handler


def worker():
    w = Worker()
    host, port = w.conf["listen"].rsplit(":", 1)
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer((host, int(port)), make_handler(w))
    signal.signal(signal.SIGTERM, lambda s, f: os._exit(0))
    log("worker: object cache of %d MiB allocated; serving the RPC on %s" % (w.cache_mb, w.conf["listen"]))
    srv.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "worker":
        worker()
    else:
        master()
