import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orchestrator } from "@/lib/orchestrator";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  errors.mockRestore();
});

const logged = () => errors.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

describe("orchestrator client", () => {
  it("turns a refused connection into a 503 with a readable message instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const r = await orchestrator<{ error: string }>("/sessions/x");
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("недоступна");
  });

  it("turns a timeout into a 503 as well", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")));
    const r = await orchestrator<{ error: string }>("/sessions/x", { timeoutMs: 10 });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("не ответила");
  });

  it("passes the status of a real answer through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "session not found" }), { status: 404 })));
    const r = await orchestrator("/sessions/x");
    expect(r.status).toBe(404);
  });

  it("logs a refused connection with its reason and code", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3080"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })));
    await orchestrator("/sessions/x?probe=1", { method: "POST" });
    expect(logged()).toEqual([expect.objectContaining({ event: "orchestrator_call_failed", reason: "connection_refused", code: "ECONNREFUSED", method: "POST", path: "/sessions/x" })]);
  });

  it("logs a timeout apart from a refused connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")));
    await orchestrator("/sessions/x");
    expect(logged()).toEqual([expect.objectContaining({ reason: "timeout" })]);
  });

  it("logs any other network failure as network_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })));
    await orchestrator("/sessions/x");
    expect(logged()).toEqual([expect.objectContaining({ reason: "network_error", code: "ECONNRESET" })]);
  });

  it("logs an answer that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 })));
    const r = await orchestrator("/sessions/x");
    expect(r.status).toBe(502);
    expect(logged()).toEqual([expect.objectContaining({ reason: "non_json_response", status: 502 })]);
  });

  it("logs a 5xx JSON answer with the orchestrator's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "docker is down" }), { status: 500 })));
    await orchestrator("/sessions/x");
    expect(logged()).toEqual([expect.objectContaining({ reason: "http_5xx", status: 500, message: "docker is down" })]);
  });

  it("stays quiet for success and for a 4xx answer, and never writes the token or a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "nope" }), { status: 404 })));
    await orchestrator("/a");
    await orchestrator("/b", { method: "POST", body: { secret: "hunter2" } });
    expect(errors).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await orchestrator("/c", { method: "POST", body: { secret: "hunter2" } });
    expect(JSON.stringify(logged())).not.toContain("hunter2");
  });
});
