#!/bin/sh
# SECRET grader. Result, not method, and one deliberate side effect: the grader performs a gateway maintenance itself
# (service seg-gw restart, the same thing the network team did) and then watches what the stand does with it.
#   after-maintenance   within 40 s after the restart every runner holds all its connections again and the notifier
#                       has delivered again; the restart is known to have dropped the old connections
#   runners-full        8 runners x 8 slots are connected to the queue through the gateway and stay connected
#   queue-drains        jobs get done faster than they arrive (or the queue is short), and no jobs are missing
#   notifier-delivers   the notifier's counter in its store grows, and its commands arrive through the gateway
#   gateway-free        a fresh connection through the gateway is answered at once
#   gateway-rules       nobody talks to the Redis instances past the gateway, and the gateway still admits new
#                       sessions at the rate its owner set (measured with a burst, not read from a file)
# Nothing the player can edit is trusted: the addresses are hard-coded, both Redis instances are asked directly
# (CLIENT LIST, MONITOR, counters), no log and no configuration file is read.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# a stand that is still booting is given a moment
i=0
while [ ! -e /run/.boot-complete ] && [ $i -lt 20 ]; do i=$((i + 1)); sleep 0.5; done

out=$(python3 -I - 2>/dev/null <<'PY'
import json
import re
import select
import socket
import subprocess
import sys
import threading
import time

QUEUE = ("127.0.30.11", 6379)
STORE = ("127.0.30.12", 6379)
VIA_GW_STORE = ("127.0.20.12", 6380)
GW_SOURCE = "127.0.30.1"
RUNNERS, SLOTS = 8, 8
WANT = RUNNERS * SLOTS
BOUND = 40.0            # seconds after the maintenance in which both services must be back
WINDOW = 6.0            # seconds of watching after that
RATE_LIMIT = 16         # new sessions per second the gateway admits
BURST = 44
BURST_WAIT = 0.5
RUNNER_NAME = re.compile(r"^runner-[1-8]/\d+$")
MONITOR_LINE = re.compile(r'^\+?\d+\.\d+ \[\d+ ([^\]]+)\] "([^"]*)"(?: "([^"]*)")?')


def command(*args):
    out = [b"*%d\r\n" % len(args)]
    for a in args:
        a = str(a).encode()
        out.append(b"$%d\r\n%s\r\n" % (len(a), a))
    return b"".join(out)


def read_reply(f):
    line = f.readline()
    if not line.endswith(b"\r\n"):
        raise ConnectionError("closed")
    kind, rest = line[:1], line[1:-2]
    if kind in (b"+", b"-"):
        return rest.decode("utf-8", "replace")
    if kind == b":":
        return int(rest)
    if kind == b"$":
        n = int(rest)
        return None if n < 0 else f.read(n + 2)[:-2].decode("utf-8", "replace")
    if kind == b"*":
        n = int(rest)
        return None if n < 0 else [read_reply(f) for _ in range(n)]
    raise ConnectionError("protocol")


def ask(addr, *cmds, timeout=3.0):
    """-> list of replies, or None when the server did not answer"""
    try:
        with socket.create_connection(addr, timeout=timeout) as s:
            f = s.makefile("rb")
            out = []
            for c in cmds:
                s.sendall(command(*c))
                out.append(read_reply(f))
            return out
    except (OSError, ConnectionError, ValueError):
        return None


def number(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


class Sample:
    """Who is connected to the queue right now, as the queue itself sees it."""

    def __init__(self):
        self.at = time.monotonic()
        r = ask(QUEUE, ("CLIENT", "LIST"))
        self.redis_up = bool(r) and isinstance(r[0], str)
        found = []
        for line in (r[0].splitlines() if self.redis_up else []):
            kv = dict(p.split("=", 1) for p in line.split(" ") if "=" in p)
            found.append({"id": kv.get("id", ""), "ip": kv.get("addr", "").rsplit(":", 1)[0], "name": kv.get("name", ""),
                          "age": number(kv.get("age"))})
        via_gw = [c for c in found if RUNNER_NAME.match(c["name"]) and c["ip"] == GW_SOURCE]
        self.pool = {c["name"]: c for c in via_gw}
        self.runners_up = sum(1 for n in range(1, RUNNERS + 1)
                              if sum(1 for name in self.pool if name.startswith("runner-%d/" % n)) >= SLOTS)
        self.past_gw = sorted({c["name"].split("/")[0] for c in found if c["name"].startswith("runner") and c["ip"] != GW_SOURCE})
        self.oldest = max([c["age"] for c in via_gw] or [0])

    @property
    def full(self):
        return len(self.pool) >= WANT and self.runners_up == RUNNERS

    def ids(self):
        return {c["id"] for c in self.pool.values()}


def counters():
    q = ask(QUEUE, ("GET", "jobs:enqueued"), ("GET", "jobs:done"), ("LLEN", "jobs:pending"))
    s = ask(STORE, ("GET", "notify:sent"))
    if q is None or s is None:
        return None
    return {"enqueued": number(q[0]), "done": number(q[1]), "pending": number(q[2]), "sent": number(s[0])}


def sent_now():
    s = ask(STORE, ("GET", "notify:sent"))
    return None if s is None else number(s[0])


class Monitor(threading.Thread):
    """Every command the notifier's store executes, with the address it came from."""

    def __init__(self):
        super().__init__(daemon=True)
        self.data = bytearray()
        self.sock = None
        try:
            self.sock = socket.create_connection(STORE, timeout=3.0)
            self.sock.sendall(command("MONITOR"))
            self.sock.settimeout(0.5)
        except OSError:
            self.sock = None
        self.running = self.sock is not None
        if self.running:
            self.start()

    def run(self):
        while self.running:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            self.data += chunk

    def result(self):
        """-> (deliveries through the gateway, names of the commands that came past it) or None"""
        if self.sock is None:
            return None
        self.running = False
        self.join(2.0)
        try:
            self.sock.close()
        except OSError:
            pass
        via_gw, past = 0, set()
        for line in bytes(self.data).decode("utf-8", "replace").splitlines():
            m = MONITOR_LINE.match(line)
            if not m:
                continue
            ip, cmd, key = m.group(1).rsplit(":", 1)[0], m.group(2).upper(), m.group(3) or ""
            if not key.startswith("notify:") or cmd in ("GET", "TTL", "EXISTS", "TYPE", "STRLEN"):
                continue
            if ip == GW_SOURCE:
                via_gw += 1 if (cmd == "INCR" and key == "notify:sent") else 0
            else:
                past.add(cmd)
        return via_gw, past


def probe(timeout=1.5):
    r = ask(VIA_GW_STORE, ("PING",), timeout=timeout)
    return bool(r) and r[0] == "PONG"


def burst():
    """BURST connections at once through the gateway; how many are answered within BURST_WAIT seconds"""
    socks = []
    for _ in range(BURST):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setblocking(False)
        try:
            s.connect_ex(VIA_GW_STORE)
        except OSError:
            pass
        socks.append(s)
    deadline = time.monotonic() + BURST_WAIT
    to_send, to_read, answered = set(socks), set(), 0
    while time.monotonic() < deadline and (to_send or to_read):
        try:
            r, w, _ = select.select(list(to_read), list(to_send), [], max(0.0, min(0.05, deadline - time.monotonic())))
        except (OSError, ValueError):
            break
        for s in w:
            to_send.discard(s)
            try:
                s.send(command("PING"))
                to_read.add(s)
            except OSError:
                pass
        for s in r:
            to_read.discard(s)
            try:
                if s.recv(16).startswith(b"+PONG"):
                    answered += 1
            except OSError:
                pass
    for s in socks:
        try:
            s.close()
        except OSError:
            pass
    return answered


def main():
    crit = []

    def add(cid, ok, msg):
        crit.append({"id": cid, "ok": bool(ok), "message": msg})

    # 1. the maintenance: the same restart the network team does
    t0 = time.monotonic()
    try:
        subprocess.run(["/usr/sbin/service", "seg-gw", "restart"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=25,
                       env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent"})
    except (OSError, subprocess.SubprocessError):
        pass
    t1 = time.monotonic()
    sent_before = sent_now()

    # 2. both services must be back within BOUND seconds
    took = None
    past_gw = set()
    while True:
        last = Sample()
        past_gw.update(last.past_gw)
        sent = sent_now()
        notifier_back = sent is not None and sent_before is not None and sent > sent_before
        if last.full and notifier_back:
            took = time.monotonic() - t1
            break
        if time.monotonic() - t1 >= BOUND:
            break
        time.sleep(1.0)
    dropped = last.oldest <= (time.monotonic() - t0) + 2

    if not last.redis_up or sent is None:
        add("after-maintenance", False, "queue-redis (127.0.30.11:6379) или notify-redis (127.0.30.12:6379) не отвечает: состояние сервисов проверить не удалось")
    elif took is None:
        add("after-maintenance", False,
            "проверка сама провела работы на шлюзе (service seg-gw restart); через %d с после них runner'ы держат %d соединений с очередью из %d, notifier за это время %s"
            % (BOUND, len(last.pool), WANT, "отправил уведомления" if notifier_back else "не отправил ни одного уведомления"))
    elif not dropped:
        add("after-maintenance", False,
            "проверка не смогла провести работы на шлюзе: после service seg-gw restart остались соединения, открытые до перезапуска")
    else:
        add("after-maintenance", True,
            "проверка сама провела работы на шлюзе (service seg-gw restart): runner'ы и notifier восстановились за %d с" % round(took))

    # 3. a window of normal work
    monitor = Monitor()
    c0 = counters()
    first = Sample()
    probes = 0
    for _ in range(3):
        time.sleep(WINDOW / 3)
        if probe():
            probes += 1
    c1 = counters()
    second = Sample()
    seen = monitor.result()
    past_gw.update(first.past_gw)
    past_gw.update(second.past_gw)
    seconds = max(second.at - first.at, 1.0)

    changed = len(first.ids() ^ second.ids())
    if not (first.redis_up and second.redis_up):
        add("runners-full", False, "queue-redis не отвечает: проверить runner'ы не удалось")
    elif not second.full:
        add("runners-full", False, "runner'ов с полным набором соединений: %d из %d; соединений с очередью через шлюз: %d из %d"
            % (second.runners_up, RUNNERS, len(second.pool), WANT))
    elif changed:
        add("runners-full", False, "соединения runner'ов с очередью не держатся: за %d с наблюдения сменилось %d" % (round(seconds), changed))
    else:
        add("runners-full", True, "все %d runner'ов держат по %d соединений с очередью через шлюз" % (RUNNERS, SLOTS))

    if c0 is None or c1 is None:
        add("queue-drains", False, "queue-redis или notify-redis не отвечает: проверить очередь не удалось")
        add("notifier-delivers", False, "notify-redis не отвечает: проверить notifier не удалось")
    else:
        done = c1["done"] - c0["done"]
        came = c1["enqueued"] - c0["enqueued"]
        missing = c1["enqueued"] - c1["done"] - c1["pending"]
        if missing > 2000:
            add("queue-drains", False, "из очереди пропали задания: поставлено %d, выполнено %d, ждут %d" % (c1["enqueued"], c1["done"], c1["pending"]))
        elif done < 10 * seconds:
            add("queue-drains", False, "задания почти не выполняются: %d за %d с при %d поступивших, в очереди %d" % (done, round(seconds), came, c1["pending"]))
        elif c1["pending"] > 400 and done <= came:
            add("queue-drains", False, "очередь не разбирается: за %d с выполнено %d заданий, поступило %d, ждут %d" % (round(seconds), done, came, c1["pending"]))
        else:
            add("queue-drains", True, "задания выполняются: %d за %d с при %d поступивших, в очереди %d" % (done, round(seconds), came, c1["pending"]))
        sent = c1["sent"] - c0["sent"]
        via_gw = seen[0] if seen is not None else sent
        if sent < 1 * seconds or via_gw < 1 * seconds:
            add("notifier-delivers", False, "notifier не отправляет уведомления через шлюз: %d за %d с" % (min(sent, via_gw), round(seconds)))
        else:
            add("notifier-delivers", True, "notifier отправляет уведомления: %d за %d с" % (sent, round(seconds)))

    if probes == 3:
        add("gateway-free", True, "новое соединение через шлюз получает ответ сразу")
    else:
        add("gateway-free", False, "новое соединение через шлюз остаётся без ответа (%d проверок из 3, ожидание 1,5 с)" % (3 - probes))

    # 4. the rules of the path
    if seen is not None and seen[1]:
        past_gw.add("notifier")
    if past_gw:
        add("gateway-rules", False, "к Redis в сегменте данных подключаются в обход шлюза: %s" % ", ".join(sorted(past_gw)[:4]))
    elif probes < 3 or not second.full:
        # while runners are still dialing they take the gateway's sessions: a burst would measure them, not the limit
        add("gateway-rules", True, "в обход шлюза никто не ходит (лимит шлюза измеряется, когда все runner'ы подключены)")
    else:
        time.sleep(1.2)
        answered = burst()
        if answered > RATE_LIMIT * (1 + BURST_WAIT) + 4:
            add("gateway-rules", False, "шлюз работает не с теми настройками, которые задала сетевая команда: их менять нельзя")
        else:
            add("gateway-rules", True, "в обход шлюза никто не ходит, шлюз работает с настройками сетевой команды")

    sys.stdout.write(json.dumps({"passed": all(c["ok"] for c in crit), "criteria": crit}, ensure_ascii=True) + "\n")


main()
PY
)

case "$out" in
  '{"passed": '*) printf '%s\n' "$out" ;;
  *) printf '{"passed":false,"criteria":[{"id":"after-maintenance","ok":false,"message":"проверка не смогла выполниться: на сервере не запускается python3 или не отвечает сеть"}]}\n' ;;
esac
