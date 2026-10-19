import { describe, expect, it, vi } from "vitest";
import { FakeRuntimeProvider, type SandboxSpec } from "../src";

const spec: SandboxSpec = { image: "img", writable: [], tmpfs: {}, capAdd: [], sudo: false, resources: { cpus: 1, memoryMb: 64, pids: 32 }, labels: {} };
const term = { user: "root", shell: "/bin/sh", cwd: "/", cols: 80, rows: 24 };

describe("FakeRuntimeProvider terminal flow control", () => {
  it("holds the output while paused and replays it on resume", async () => {
    const fake = new FakeRuntimeProvider();
    const t = await fake.openTerminal(await fake.create(spec), term);
    const seen: string[] = [];
    t.onData((c) => seen.push(c.toString()));

    t.pause?.();
    t.write("a");
    t.write("b");
    expect(seen).toEqual([]);
    t.resume?.();
    expect(seen).toEqual(["echo:a", "echo:b"]);
  });

  it("stops replaying when a listener pauses again in the middle of the backlog", async () => {
    const fake = new FakeRuntimeProvider();
    const t = await fake.openTerminal(await fake.create(spec), term);
    const seen: string[] = [];
    t.onData((c) => {
      seen.push(c.toString());
      t.pause?.();
    });
    t.pause?.();
    t.write("a");
    t.write("b");
    t.resume?.();
    expect(seen).toEqual(["echo:a"]);
    t.resume?.();
    expect(seen).toEqual(["echo:a", "echo:b"]);
  });

  it("reports an unread input until drainTerminalInput", async () => {
    const fake = new FakeRuntimeProvider();
    const t = await fake.openTerminal(await fake.create(spec), term);
    const drained = vi.fn();
    t.onDrain?.(drained);
    expect(t.writable?.()).toBe(true);
    fake.terminalInputFull = true;
    expect(t.writable?.()).toBe(false);
    fake.drainTerminalInput();
    expect(t.writable?.()).toBe(true);
    expect(drained).toHaveBeenCalledTimes(1);
  });
});
