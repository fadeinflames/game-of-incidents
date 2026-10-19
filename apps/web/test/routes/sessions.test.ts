import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
const orch = vi.hoisted(() => ({ orchestrator: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/orchestrator", () => ({ ORCH_TIMEOUT: { create: 1, kill: 2 }, orchestrator: orch.orchestrator }));

import { POST as createSession } from "@/app/api/sessions/route";
import { jsonRequest } from "./helpers";

const scenarioId = "cl0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUser.mockResolvedValue({ id: "u1", username: "alice", email: null, role: "user" });
  orch.orchestrator.mockResolvedValue({ status: 201, body: { id: "s1" } });
});

describe("POST /api/sessions", () => {
  it("passes a public client address to the orchestrator for the per-IP quota", async () => {
    const res = await createSession(jsonRequest("/api/sessions", { scenarioId }, { "x-forwarded-for": "198.51.100.7" }));
    expect(res.status).toBe(201);
    const [path, opts] = orch.orchestrator.mock.calls[0];
    expect(path).toBe("/sessions");
    expect(opts.body).toEqual({ userId: "u1", scenarioId, clientIp: "198.51.100.7" });
  });

  it("sends no address when the proxy only shows an internal one", async () => {
    await createSession(jsonRequest("/api/sessions", { scenarioId }, { "x-forwarded-for": "172.18.0.1" }));
    expect(orch.orchestrator.mock.calls[0][1].body.clientIp).toBeUndefined();
  });

  it("does not trust an address the client put first in X-Forwarded-For", async () => {
    await createSession(jsonRequest("/api/sessions", { scenarioId }, { "x-forwarded-for": "6.6.6.6, 198.51.100.8" }));
    expect(orch.orchestrator.mock.calls[0][1].body.clientIp).toBe("198.51.100.8");
  });

  it("requires a login", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    const res = await createSession(jsonRequest("/api/sessions", { scenarioId }));
    expect(res.status).toBe(401);
    expect(orch.orchestrator).not.toHaveBeenCalled();
  });

  it("refuses a request without a scenario", async () => {
    const res = await createSession(jsonRequest("/api/sessions", {}));
    expect(res.status).toBe(400);
    expect(orch.orchestrator).not.toHaveBeenCalled();
  });

  it("relays the refusal of the orchestrator as it is", async () => {
    orch.orchestrator.mockResolvedValue({ status: 429, body: { error: "Слишком много стендов с этого адреса" } });
    const res = await createSession(jsonRequest("/api/sessions", { scenarioId }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("стендов");
  });
});
