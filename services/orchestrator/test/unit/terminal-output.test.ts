import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardTerminalOutput } from "../../src/server";

function fakeSocket() {
  const sent: Buffer[] = [];
  const ws = { OPEN: 1 as const, readyState: 1 as number, bufferedAmount: 0, send: (data: Buffer) => void sent.push(data) };
  return { ws, sent };
}

const MB = 1024 * 1024;
const NOTICE = "вывод пропущен: слишком быстрый поток";

describe("forwardTerminalOutput (terminal backpressure)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("forwards output while the browser keeps up", () => {
    const { ws, sent } = fakeSocket();
    const forward = forwardTerminalOutput(ws as never);
    forward(Buffer.from("a"));
    ws.bufferedAmount = MB; // at the mark, not above it
    forward(Buffer.from("b"));
    expect(sent.map(String)).toEqual(["a", "b"]);
  });

  it("drops output above the high-water mark, says so once, and resumes with the newest dropped bytes after the queue drains", () => {
    const { ws, sent } = fakeSocket();
    const forward = forwardTerminalOutput(ws as never);
    ws.bufferedAmount = MB + 1;
    forward(Buffer.from("x1"));
    forward(Buffer.from("x2"));
    ws.bufferedAmount = 512 * 1024; // below the high mark but not yet drained: still dropping
    forward(Buffer.from("x3"));
    expect(sent).toHaveLength(1);
    expect(sent[0].toString()).toContain(NOTICE);
    ws.bufferedAmount = 100 * 1024;
    forward(Buffer.from("y"));
    expect(sent.slice(1).map(String)).toEqual(["x1x2x3", "y"]);
    // a second burst is announced again
    ws.bufferedAmount = 2 * MB;
    forward(Buffer.from("z"));
    expect(sent).toHaveLength(4);
    expect(sent[3].toString()).toContain(NOTICE);
  });

  it("keeps a bounded tail of a long burst", () => {
    const { ws, sent } = fakeSocket();
    const forward = forwardTerminalOutput(ws as never);
    ws.bufferedAmount = 2 * MB;
    for (let i = 0; i < 100; i++) forward(Buffer.alloc(4096, "y"));
    forward(Buffer.from("user@host:~$ "));
    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(2);
    expect(sent[1].length).toBe(16 * 1024);
    expect(sent[1].toString().endsWith("user@host:~$ ")).toBe(true);
  });

  it("delivers the tail when the output stops during the burst: the prompt is not lost", () => {
    const { ws, sent } = fakeSocket();
    const forward = forwardTerminalOutput(ws as never);
    ws.bufferedAmount = 2 * MB;
    forward(Buffer.from("y\r\n$ "));
    vi.advanceTimersByTime(500);
    expect(sent).toHaveLength(1); // still over the mark: nothing but the notice
    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(150);
    expect(sent.slice(1).map(String)).toEqual(["y\r\n$ "]);
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing to a socket that is not open and stops watching a socket that closed during a burst", () => {
    const { ws, sent } = fakeSocket();
    const forward = forwardTerminalOutput(ws as never);
    ws.bufferedAmount = 2 * MB;
    forward(Buffer.from("a"));
    ws.readyState = 3;
    forward(Buffer.from("b"));
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
