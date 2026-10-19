// In-memory RuntimeProvider for tests: no Docker required.
import { EventEmitter } from "node:events";
import type {
  ExecResult,
  ListedSandbox,
  RuntimeProvider,
  SandboxHandle,
  SandboxSpec,
  SandboxStatus,
  TerminalOptions,
  TerminalStream,
} from "./types";
import { ProvisioningAborted, SESSION_LABEL, type ScriptOptions } from "./types";

type Fake = { spec: SandboxSpec; status: SandboxStatus; createdAt: Date };

export class FakeRuntimeProvider implements RuntimeProvider {
  sandboxes = new Map<string, Fake>();
  scripts: string[] = [];
  /** what runScript returns; tests override per script content */
  scriptResponder: (script: string, user: string) => ExecResult = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  createDelayMs = 0;
  failCreate = false;
  /** how long every script "runs"; a sandbox destroyed meanwhile makes it exit 137 like a killed runner */
  scriptDelayMs = 0;
  /** true => create() runs to the end even when the spec's signal fires (a provider step that cannot be interrupted) */
  ignoreAbort = false;
  /** true => every terminal reports writable() === false (a sandbox that does not read its stdin) until drainTerminalInput() */
  terminalInputFull = false;
  private terminals = new Set<EventEmitter>();
  private seq = 0;

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (this.failCreate) throw new Error("fake: create failed");
    if (this.createDelayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.createDelayMs);
        if (this.ignoreAbort) return;
        spec.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new ProvisioningAborted())), { once: true });
      });
    }
    const id = `fake-${++this.seq}`;
    this.sandboxes.set(id, { spec, status: "running", createdAt: new Date() });
    return { provider: "docker", containerId: id, networkId: `net-${id}` };
  }

  async runScript(h: SandboxHandle, script: string, opts: ScriptOptions): Promise<ExecResult> {
    if (!this.sandboxes.has(h.containerId)) throw new Error("fake: no such sandbox");
    this.scripts.push(script);
    if (this.scriptDelayMs) {
      await new Promise((r) => setTimeout(r, this.scriptDelayMs));
      if (opts.signal?.aborted) return { exitCode: -1, stdout: "", stderr: "", timedOut: false };
      if (!this.sandboxes.has(h.containerId)) return { exitCode: 137, stdout: "", stderr: "", timedOut: false };
    }
    return this.scriptResponder(script, opts.user);
  }

  async openTerminal(h: SandboxHandle, _opts: TerminalOptions): Promise<TerminalStream> {
    if (!this.sandboxes.has(h.containerId)) throw new Error("fake: no such sandbox");
    const em = new EventEmitter();
    this.terminals.add(em);
    let paused = false;
    const held: Buffer[] = [];
    return {
      write: (data) => {
        const chunk = Buffer.from(`echo:${data.toString()}`);
        if (paused) held.push(chunk);
        else em.emit("data", chunk);
      },
      resize: async () => {},
      end: () => {
        this.terminals.delete(em);
        em.emit("end");
      },
      onData: (cb) => em.on("data", cb),
      onEnd: (cb) => em.on("end", cb),
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
        // a listener may pause again in the middle of the backlog
        while (!paused && held.length) em.emit("data", held.shift()!);
      },
      writable: () => !this.terminalInputFull,
      onDrain: (cb) => em.on("drain", cb),
    };
  }

  /** test helper: the sandbox took its stdin again; terminals become writable and their onDrain callbacks run */
  drainTerminalInput() {
    this.terminalInputFull = false;
    for (const em of this.terminals) em.emit("drain");
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    return this.sandboxes.get(h.containerId)?.status ?? "missing";
  }

  async destroy(h: SandboxHandle): Promise<void> {
    this.sandboxes.delete(h.containerId);
  }

  async list(): Promise<ListedSandbox[]> {
    return [...this.sandboxes.entries()].map(([id, f]) => ({
      handle: { provider: "docker", containerId: id, networkId: `net-${id}` },
      sessionId: f.spec.labels[SESSION_LABEL] ?? null,
      createdAt: f.createdAt,
      labels: f.spec.labels,
    }));
  }

  /** test helper: simulate a container that vanished behind our back */
  vanish(containerId: string) {
    this.sandboxes.delete(containerId);
  }

  /** test helper: an orphan container nobody has a session for */
  addOrphan(sessionId: string | null) {
    const id = `orphan-${++this.seq}`;
    const labels: Record<string, string> = sessionId ? { [SESSION_LABEL]: sessionId } : {};
    this.sandboxes.set(id, {
      spec: { image: "x", writable: [], tmpfs: {}, capAdd: [], sudo: false, resources: { cpus: 1, memoryMb: 1, pids: 1 }, labels },
      status: "running",
      createdAt: new Date(),
    });
    return id;
  }
}
