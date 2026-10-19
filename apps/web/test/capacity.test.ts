import { beforeEach, describe, expect, it, vi } from "vitest";

const orch = vi.hoisted(() => ({ orchestrator: vi.fn() }));
vi.mock("@/lib/orchestrator", () => orch);

import { CAPACITY_TIMEOUT_MS, getCapacity } from "@/lib/capacity";

beforeEach(() => orch.orchestrator.mockReset());

describe("getCapacity", () => {
  it("waits one second at most: the numbers are a nicety on the render path", async () => {
    orch.orchestrator.mockResolvedValue({ status: 200, body: { all: { active: 1, max: 4 }, kubernetes: { active: 0, max: 3 } } });
    await getCapacity();
    expect(CAPACITY_TIMEOUT_MS).toBe(1000);
    expect(orch.orchestrator).toHaveBeenCalledWith("/capacity", { timeoutMs: 1000 });
  });

  it("returns the numbers on 200", async () => {
    const body = { all: { active: 2, max: 4 }, kubernetes: { active: 1, max: 3 } };
    orch.orchestrator.mockResolvedValue({ status: 200, body });
    expect(await getCapacity()).toEqual(body);
  });

  it("returns null when the orchestrator is busy, down or slow, so the page renders without the numbers", async () => {
    orch.orchestrator.mockResolvedValue({ status: 503, body: { error: "down" } });
    expect(await getCapacity()).toBeNull();
  });
});
