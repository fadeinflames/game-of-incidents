import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DEFAULT_CAPS, DockerRuntimeProvider, FORBIDDEN_CAPS, normalizeCapability, type SandboxSpec } from "../src";
import { SCRIPT_OUTPUT_TAIL_BYTES } from "../src/output-limit";

const spec = (capAdd: string[]): SandboxSpec => ({
  image: "img",
  writable: ["/etc", "/root"],
  tmpfs: {},
  capAdd,
  sudo: true,
  resources: { cpus: 1, memoryMb: 64, pids: 32 },
  labels: {},
});

/** a provider whose daemon calls are captured instead of sent (the socket does not exist) */
function stubbed() {
  const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
  const createNetwork = vi.spyOn(provider.docker, "createNetwork").mockResolvedValue({ id: "net" } as Docker.Network);
  const createContainer = vi
    .spyOn(provider.docker, "createContainer")
    .mockResolvedValue({ id: "ctr", start: async () => undefined } as unknown as Docker.Container);
  return { provider, createNetwork, createContainer };
}

describe("normalizeCapability", () => {
  it("maps every spelling Docker accepts to one name", () => {
    for (const c of ["SYS_ADMIN", "sys_admin", "CAP_SYS_ADMIN", "cap_sys_admin", " Cap_Sys_Admin\n", "CAP_CAP_SYS_ADMIN"]) {
      expect(normalizeCapability(c)).toBe("SYS_ADMIN");
    }
  });
});

describe("DockerRuntimeProvider.create", () => {
  it.each(["SYS_ADMIN", "CAP_SYS_ADMIN", "sys_admin", "cap_sys_ptrace", " CAP_NET_ADMIN", "CAP_CAP_SYS_ADMIN", "cap_all"])(
    "refuses the forbidden capability %j before touching the daemon",
    async (cap) => {
      const { provider, createNetwork, createContainer } = stubbed();
      await expect(provider.create(spec(["CHOWN", cap]))).rejects.toThrow(/forbidden/);
      expect(createNetwork).not.toHaveBeenCalled();
      expect(createContainer).not.toHaveBeenCalled();
    },
  );

  it("refuses every forbidden capability with a CAP_ prefix", async () => {
    for (const cap of FORBIDDEN_CAPS) {
      await expect(stubbed().provider.create(spec([`CAP_${cap}`]))).rejects.toThrow(/forbidden/);
    }
  });

  it("refuses values that are not capability names", async () => {
    await expect(stubbed().provider.create(spec(["CHOWN,SYS_ADMIN"]))).rejects.toThrow(/not a capability name/);
    await expect(stubbed().provider.create(spec([""]))).rejects.toThrow(/not a capability name/);
  });

  it("hands Docker normalized capabilities and only the fixed read-only /dev/null mounts", async () => {
    const { provider, createContainer } = stubbed();
    await provider.create(spec(["cap_chown", "KILL"]));
    const host = createContainer.mock.calls[0]![0].HostConfig!;
    expect(host.CapAdd).toEqual(["CHOWN", "KILL"]);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.Privileged).toBe(false);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([
      { Type: "bind", Source: "/dev/null", Target: "/etc/ld.so.preload", ReadOnly: true },
      { Type: "bind", Source: "/dev/null", Target: "/nonexistent/.curlrc", ReadOnly: true },
    ]);
  });

  it("accepts the default capabilities", async () => {
    const { provider, createContainer } = stubbed();
    await provider.create(spec(DEFAULT_CAPS));
    expect(createContainer.mock.calls[0]![0].HostConfig!.CapAdd).toEqual(DEFAULT_CAPS);
  });
});

describe("DockerRuntimeProvider.runScript", () => {
  it("runs the script with a home the player cannot write and rc files pointed away from /root", async () => {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    let options: Docker.ExecCreateOptions | undefined;
    const exec = { start: async () => new PassThrough(), inspect: async () => ({ ExitCode: 0 }) };
    vi.spyOn(provider.docker, "getContainer").mockReturnValue({
      exec: async (o: Docker.ExecCreateOptions) => {
        options = o;
        return exec;
      },
    } as unknown as Docker.Container);

    const r = await provider.runScript({ provider: "docker", containerId: "ctr", networkId: "net" }, "true", { user: "root", timeoutMs: 5_000 });

    expect(r.exitCode).toBe(0);
    // the script still arrives over stdin; the deadline (plus one second) is enforced inside the sandbox when timeout(1) exists
    expect(options?.Cmd?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(options?.Cmd?.[2]).toContain('exec timeout -s KILL "$0" /bin/sh -s');
    expect(options?.Cmd?.[2]).toMatch(/exec \/bin\/sh -s$/);
    expect(options?.Cmd?.[3]).toBe("6");
    expect(options?.Env).toEqual([
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/nonexistent",
      "LD_PRELOAD=",
      "PSQLRC=/nonexistent/.psqlrc",
      "CURL_HOME=/nonexistent",
    ]);
  });
});

describe("DockerRuntimeProvider.runScript output limits", () => {
  /** a frame of the multiplexed exec stream: 1 = stdout, 2 = stderr */
  const frame = (type: 1 | 2, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };

  /** the hijacked socket, fed by the test after runScript has started reading it */
  function run(feed: (s: EventEmitter & { destroyed: boolean }) => void) {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    const s = Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn(),
      end: vi.fn(() => setImmediate(() => feed(s))),
      destroy: vi.fn(() => {
        s.destroyed = true;
        setImmediate(() => s.emit("close"));
      }),
    });
    const inspect = vi.fn(async () => ({ ExitCode: 0 }));
    vi.spyOn(provider.docker, "getContainer").mockReturnValue({
      exec: async () => ({ start: async () => s, inspect }),
    } as unknown as Docker.Container);
    const result = provider.runScript({ provider: "docker", containerId: "ctr", networkId: "net" }, "true", { user: "root", timeoutMs: 20_000 });
    return { result, socket: s, inspect };
  }

  it("keeps the tail of a long output and not the head", async () => {
    const line = Buffer.from("x".repeat(1023) + "\n");
    const { result } = run((s) => {
      for (let i = 0; i < 1000; i++) s.emit("data", frame(1, i === 999 ? Buffer.from('{"passed":false}\n') : line)); // about 1 MB: over the tail, under the hard cap
      s.emit("end");
    });
    const r = await result;
    expect(r.outputTooLarge).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(SCRIPT_OUTPUT_TAIL_BYTES);
    expect(r.stdout.endsWith('{"passed":false}\n')).toBe(true);
  });

  it("keeps the tails of stdout and stderr apart", async () => {
    const { result } = run((s) => {
      s.emit("data", frame(1, Buffer.from("o".repeat(SCRIPT_OUTPUT_TAIL_BYTES + 10))));
      s.emit("data", frame(2, Buffer.from("e".repeat(SCRIPT_OUTPUT_TAIL_BYTES + 10))));
      s.emit("end");
    });
    const r = await result;
    expect(r.stdout).toBe("o".repeat(SCRIPT_OUTPUT_TAIL_BYTES));
    expect(r.stderr).toBe("e".repeat(SCRIPT_OUTPUT_TAIL_BYTES));
  });

  it("drops the stream past the hard cap and reports it instead of an exit code", async () => {
    const chunk = frame(1, Buffer.alloc(64 * 1024, "a"));
    const { result, socket, inspect } = run((s) => {
      // a flood that never ends on its own: stops only because the stream is destroyed
      const pump = () => {
        for (let i = 0; i < 16 && !s.destroyed; i++) s.emit("data", chunk);
        if (!s.destroyed) setImmediate(pump);
      };
      pump();
    });
    const r = await result;
    expect(r).toMatchObject({ outputTooLarge: true, exitCode: -1, timedOut: false });
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(SCRIPT_OUTPUT_TAIL_BYTES);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("counts the bytes of a frame announcing far more than it carries", async () => {
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(0xffffffff, 4);
    const body = Buffer.alloc(64 * 1024, "b");
    const { result } = run((s) => {
      s.emit("data", header);
      const pump = () => {
        for (let i = 0; i < 16 && !s.destroyed; i++) s.emit("data", body);
        if (!s.destroyed) setImmediate(pump);
      };
      pump();
    });
    expect(await result).toMatchObject({ outputTooLarge: true, exitCode: -1 });
  });
});

describe("DockerRuntimeProvider.openTerminal flow control", () => {
  /** the hijacked daemon socket: an emitter with the bits of Duplex the provider touches */
  function socket() {
    const s = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn(), write: vi.fn(), end: vi.fn(), writableNeedDrain: false });
    return s;
  }

  async function terminal(s: ReturnType<typeof socket>) {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    vi.spyOn(provider.docker, "getContainer").mockReturnValue({
      exec: async () => ({ start: async () => s, resize: async () => undefined }),
    } as unknown as Docker.Container);
    return provider.openTerminal({ provider: "docker", containerId: "ctr", networkId: "net" }, { user: "root", shell: "/bin/sh", cwd: "/", cols: 80, rows: 24 });
  }

  it("pauses and resumes reading the sandbox output", async () => {
    const s = socket();
    const t = await terminal(s);
    t.pause?.();
    expect(s.pause).toHaveBeenCalledTimes(1);
    t.resume?.();
    expect(s.resume).toHaveBeenCalledTimes(1);
  });

  it("reports a full input buffer until the socket drains", async () => {
    const s = socket();
    const t = await terminal(s);
    const onDrain = vi.fn();
    t.onDrain?.(onDrain);
    expect(t.writable?.()).toBe(true);
    s.writableNeedDrain = true;
    expect(t.writable?.()).toBe(false);
    s.writableNeedDrain = false;
    s.emit("drain");
    expect(t.writable?.()).toBe(true);
    expect(onDrain).toHaveBeenCalledTimes(1);
  });
});
