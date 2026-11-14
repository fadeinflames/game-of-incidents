#!/usr/bin/env python3
"""loadgen: the users of the translation product (stand-in for the outside world).

60 accounts work in the editor plugin, 4 run the command-line tool from scheduled jobs.

  translator-plugin/2.8.4  asks for the engine list once at the start of a job (about every 40 s), then translates
  translator-plugin/2.9.0  keeps the engine list fresh while the editor is open: asks for it every 2 s; a job every 30 s
  translator-cli/1.4.1     one job a minute

/var/lib/loadgen/fleet.json says how many plugin accounts already run 2.9.0. Most editor sessions come in waves: a rush
starts every 140 s (a working day squeezed into a couple of minutes), a few accounts stay online all the time.
"""
import asyncio
import json

EDGE = ("127.0.0.1", 80)
FLEET_FILE = "/var/lib/loadgen/fleet.json"

SESSION_ACCOUNTS = 50   # acc-1001 .. acc-1050: editor sessions that follow the waves
ALWAYS_ONLINE = 4       # the first of them never close the editor
STEADY_PLUGIN = 10      # acc-1051 .. acc-1060: plugin 2.8.4, spread evenly over time
CLI_ACCOUNTS = 4        # acc-1061 .. acc-1064

CYCLE = 140.0
JOIN_FROM, JOIN_OVER = 5.0, 15.0     # sessions open between second 5 and second 20 of a cycle
LEAVE_FROM, LEAVE_OVER = 65.0, 10.0  # and close between second 65 and second 75

UA_OLD = "translator-plugin/2.8.4 (editor)"
UA_NEW = "translator-plugin/2.9.0 (editor)"
UA_CLI = "translator-cli/1.4.1"


async def call(method, path, account, agent, body=None):
    """One request through the public entry point. Returns the HTTP status, 0 if there was no answer."""
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(*EDGE), 5)
    except (OSError, asyncio.TimeoutError):
        return 0
    try:
        head = f"{method} {path} HTTP/1.0\r\nHost: api.translate.example\r\nX-Account: {account}\r\nUser-Agent: {agent}\r\nConnection: close\r\n"
        if body is not None:
            head += f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
        writer.write(head.encode() + b"\r\n" + (body or b""))
        await writer.drain()
        data = await asyncio.wait_for(reader.read(), 15)
        return int(data.split(None, 2)[1])
    except (OSError, asyncio.TimeoutError, IndexError, ValueError):
        return 0
    finally:
        writer.close()


async def job(account, agent):
    """What every client does for one piece of work: the engine list first, the translation only if the list came."""
    if await call("GET", "/v1/engines", account, agent) != 200:
        return False
    body = json.dumps({"engine": "std", "text": "Quarterly report, section 4"}).encode()
    await call("POST", "/v1/translate", account, agent, body)
    return True


def session_window(i):
    k = (i - ALWAYS_ONLINE) / (SESSION_ACCOUNTS - ALWAYS_ONLINE - 1)
    return JOIN_FROM + k * JOIN_OVER, LEAVE_FROM + k * LEAVE_OVER


async def editor_session(i, updated, t0):
    loop = asyncio.get_running_loop()
    account = f"acc-{1001 + i}"
    last_job = -1000.0
    while True:
        if i >= ALWAYS_ONLINE:
            c = (loop.time() - t0) % CYCLE
            opens, closes = session_window(i)
            if c < opens:
                await asyncio.sleep(opens - c)
                continue
            if c >= closes:
                await asyncio.sleep(CYCLE - c + opens)
                continue
        if not updated:
            await job(account, UA_OLD)
            await asyncio.sleep(40.0)
            continue
        # 2.9.0: the engine list is refreshed every 2 s while the editor is open
        status = await call("GET", "/v1/engines", account, UA_NEW)
        if status == 200 and loop.time() - last_job >= 30.0:
            last_job = loop.time()
            body = json.dumps({"engine": "std", "text": "Release notes, draft"}).encode()
            await call("POST", "/v1/translate", account, UA_NEW, body)
        await asyncio.sleep(2.0)


async def steady(account, agent, every, offset):
    await asyncio.sleep(offset)
    while True:
        await job(account, agent)
        await asyncio.sleep(every)


async def main():
    try:
        with open(FLEET_FILE, encoding="utf-8") as f:
            updated = int(json.load(f).get("plugin_2_9_accounts", 0))
    except (OSError, ValueError, TypeError, AttributeError):
        updated = 0
    t0 = asyncio.get_running_loop().time()
    tasks = [editor_session(i, i < updated, t0) for i in range(SESSION_ACCOUNTS)]
    tasks += [steady(f"acc-{1001 + SESSION_ACCOUNTS + k}", UA_OLD, 40.0, k * 40.0 / STEADY_PLUGIN) for k in range(STEADY_PLUGIN)]
    tasks += [steady(f"acc-{1001 + SESSION_ACCOUNTS + STEADY_PLUGIN + k}", UA_CLI, 60.0, 7.0 + k * 15.0) for k in range(CLI_ACCOUNTS)]
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
