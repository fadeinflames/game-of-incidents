import { describe, expect, it, vi } from "vitest";
import { DockerRuntimeProvider } from "../src";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString().replace("Z", "123456Z"); // docker prints nanoseconds

type Net = { Id: string; Name: string; Created: string; Containers?: Record<string, unknown> };

function withNetworks(nets: Net[], removeError?: Record<string, unknown>) {
  const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
  const remove = vi.fn(async (id: string) => {
    if (removeError?.[id]) throw removeError[id];
  });
  vi.spyOn(provider.docker, "listNetworks").mockResolvedValue(nets as never);
  vi.spyOn(provider.docker, "getNetwork").mockImplementation(((id: string) => ({
    inspect: async () => nets.find((n) => n.Id === id),
    remove: () => remove(id),
  })) as never);
  return { provider, remove };
}

describe("DockerRuntimeProvider.removeOrphanNetworks", () => {
  it("removes every empty sandbox network when no age is given (startup)", async () => {
    const { provider, remove } = withNetworks([
      { Id: "a", Name: "wom-sb-a", Created: minutesAgo(0) },
      { Id: "b", Name: "wom-sb-b", Created: minutesAgo(90), Containers: { c1: {} } },
    ]);
    expect(await provider.removeOrphanNetworks()).toBe(1);
    expect(remove.mock.calls).toEqual([["a"]]);
  });

  it("with an age limit it spares a network that may still be waiting for its first container", async () => {
    const { provider, remove } = withNetworks([
      { Id: "young", Name: "wom-k8s-young", Created: minutesAgo(2) },
      { Id: "old", Name: "wom-k8s-old", Created: minutesAgo(30) },
      { Id: "busy", Name: "wom-k8s-busy", Created: minutesAgo(30), Containers: { c1: {} } },
      { Id: "unknown-age", Name: "wom-k8s-x", Created: "not a date" },
    ]);
    expect(await provider.removeOrphanNetworks(10 * 60_000, NOW)).toBe(1);
    expect(remove.mock.calls).toEqual([["old"]]);
  });

  it("counts only the networks that were really removed and reports the failures", async () => {
    const { provider, remove } = withNetworks(
      [
        { Id: "stuck", Name: "wom-sb-stuck", Created: minutesAgo(60) },
        { Id: "gone", Name: "wom-sb-gone", Created: minutesAgo(60) },
        { Id: "ok", Name: "wom-sb-ok", Created: minutesAgo(60) },
      ],
      { stuck: new Error("has active endpoints"), gone: Object.assign(new Error("no such network"), { statusCode: 404 }) },
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await provider.removeOrphanNetworks(60_000, NOW)).toBe(1);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1); // the stuck one; a network that vanished meanwhile is not news
    expect(log.mock.calls[0][0]).toMatch(/wom-sb-stuck.*active endpoints/);
    log.mockRestore();
  });
});

describe("DockerRuntimeProvider.defaultAddressPools", () => {
  it("is empty when the daemon runs with its built-in pools", async () => {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    vi.spyOn(provider.docker, "info").mockResolvedValue({ ID: "x" } as never);
    expect(await provider.defaultAddressPools()).toEqual([]);
  });

  it("returns the configured pools", async () => {
    const provider = new DockerRuntimeProvider("/nonexistent/docker.sock");
    vi.spyOn(provider.docker, "info").mockResolvedValue({ DefaultAddressPools: [{ Base: "10.200.0.0/12", Size: 24 }] } as never);
    expect(await provider.defaultAddressPools()).toEqual([{ Base: "10.200.0.0/12", Size: 24 }]);
  });
});
