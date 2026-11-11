#!/usr/bin/env python3
"""Build-time seed of billing-01: the accounts, a ledger with a day of history, the card processor's charges of that day,
and the Redis balances at four moments (three backup snapshots and the final state).

Everything is derived from a hand-written generator and a fixed epoch, so the image content is the same on every build.
The entrypoint moves the timestamps to "now" on the first boot.
"""
import os
import sqlite3
import sys
import time

SEED_EPOCH = 1700000000  # the moment the history ends; shifted to the boot time by stand-init
HOUR = 3600
out = sys.argv[1]


class Gen:
    def __init__(self, x):
        self.x = x

    def below(self, n):
        self.x = (self.x * 1103515245 + 12345) % 2147483648
        return (self.x >> 8) % n

    def between(self, a, b):
        return a + self.below(b - a + 1)


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


FIRST = ["Blue", "Quiet", "Rapid", "Amber", "North", "Stone", "Bright", "Green"]
SECOND = ["Harbor", "Orchard", "Signal", "Lantern", "Bridge"]

accounts = {}
for n, acct in enumerate(range(1001, 1041)):
    auto = 1 if acct % 5 in (1, 2, 4) else 0
    accounts[acct] = {
        "name": "%s %s LLC" % (FIRST[n % 8], SECOND[n // 8]),
        "auto": auto,
        "threshold": (1000 if acct % 2 else 500) if auto else 0,
        "recharge": (2000 if acct % 3 else 5000) if auto else 0,
        "card": "tok_%08x" % ((acct * 2654435761) % 4294967296),
    }

def simulate(extra):
    """One day of billing with the worker's own rules. `extra` raises the opening balance of the given accounts."""
    g = Gen(20130718)
    ledger = []    # (ts, account, kind, amount, ref)
    charges = []   # (id, ts, account, card, amount)
    balance = {}
    for acct, a in accounts.items():
        opening = (g.between(1100, 2600) if a["auto"] else g.between(3000, 9000)) + extra.get(acct, 0)
        balance[acct] = opening
        ledger.append((SEED_EPOCH - 30 * 24 * HOUR + (acct - 1001) * 7, acct, "opening", opening, "migration-2023"))
    snapshots = {}
    marks = [(SEED_EPOCH - 18 * HOUR, "1"), (SEED_EPOCH - 12 * HOUR, "2"), (SEED_EPOCH - 6 * HOUR, "3")]
    events = 1400
    start, end = SEED_EPOCH - 20 * HOUR, SEED_EPOCH - 4 * 60
    for i in range(events):
        ts = start + (end - start) * i // events + g.below(40)
        while marks and ts >= marks[0][0]:
            snapshots[marks.pop(0)[1]] = dict(balance)
        acct = 1001 + g.below(40)
        a = accounts[acct]
        cost = g.between(1, 12) if g.below(3) else g.between(20, 80)
        ref = "%s%09x" % ("SM" if cost <= 12 else "CA", g.below(16 ** 7))
        if not a["auto"] and balance[acct] - cost < 800:
            continue
        ledger.append((ts, acct, "usage", -cost, ref))
        balance[acct] -= cost
        if a["auto"] and balance[acct] < a["threshold"]:
            cid = "ch_%06d" % (len(charges) + 1)
            charges.append((cid, ts, acct, a["card"], a["recharge"]))
            ledger.append((ts, acct, "recharge", a["recharge"], cid))
            balance[acct] += a["recharge"]
    snapshots["final"] = dict(balance)
    return ledger, charges, balance, snapshots


# Every auto-recharge account must end the day well above its threshold, so that no honest recharge is due during a
# session. An account that ends too close gets a larger opening balance and the day is replayed.
extra = {}
for attempt in range(40):
    ledger, charges, balance, snapshots = simulate(extra)
    close = [k for k, a in accounts.items() if a["auto"] and balance[k] < a["threshold"] + 800]
    if not close:
        break
    for k in close:
        extra[k] = extra.get(k, 0) + 350
else:
    raise SystemExit("seed: the balances did not settle")
for acct, a in accounts.items():
    assert balance[acct] >= (a["threshold"] + 800 if a["auto"] else 800), (acct, balance[acct])

db = sqlite3.connect(os.path.join(out, "billing.db"))
db.executescript("""
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, auto_recharge INTEGER NOT NULL,
  threshold_cents INTEGER NOT NULL, recharge_cents INTEGER NOT NULL, card TEXT NOT NULL);
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'usage', 'recharge', 'refund')),
  amount_cents INTEGER NOT NULL, ref TEXT);
CREATE INDEX ledger_account ON ledger(account_id);
CREATE INDEX ledger_ref ON ledger(ref);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
""")
db.executemany("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)",
               [(k, a["name"], a["auto"], a["threshold"], a["recharge"], a["card"]) for k, a in accounts.items()])
db.executemany("INSERT INTO ledger (ts, account_id, kind, amount_cents, ref) VALUES (?, ?, ?, ?, ?)",
               [(iso(t), acct, kind, amount, ref) for t, acct, kind, amount, ref in ledger])
db.execute("INSERT INTO meta VALUES ('seed_epoch', ?)", (str(SEED_EPOCH),))
db.commit()
sums = dict(db.execute("SELECT account_id, SUM(amount_cents) FROM ledger GROUP BY account_id"))
assert sums == balance, "the ledger does not add up to the balances"
opening_sig = db.execute("SELECT SUM(account_id * amount_cents) FROM ledger WHERE kind = 'opening'").fetchone()[0]
acct_sig = db.execute("SELECT SUM(id * (auto_recharge * 1000003 + threshold_cents * 7 + recharge_cents)) FROM accounts").fetchone()[0]
db.close()

cp = sqlite3.connect(os.path.join(out, "cardproc.db"))
cp.executescript("""
CREATE TABLE charges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL, account_id INTEGER NOT NULL,
  card TEXT NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'approved');
CREATE TABLE refunds (
  charge_id TEXT PRIMARY KEY REFERENCES charges(id), ts TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
""")
cp.executemany("INSERT INTO charges (id, ts, account_id, card, amount_cents) VALUES (?, ?, ?, ?, ?)",
               [(cid, iso(t), acct, card, amount) for cid, t, acct, card, amount in charges])
cp.execute("INSERT INTO meta VALUES ('seed_epoch', ?)", (str(SEED_EPOCH),))
cp.commit()
cp.close()

assert sorted(snapshots) == ["1", "2", "3", "final"]
for name, state in snapshots.items():
    with open(os.path.join(out, "state-%s.redis" % name), "w") as f:
        for acct in sorted(state):
            f.write("SET balance:%d %d\n" % (acct, state[acct]))

print("seed: accounts=%d ledger_rows=%d history_charges=%d opening_sig=%d acct_sig=%d" % (
    len(accounts), len(ledger), len(charges), opening_sig, acct_sig))
