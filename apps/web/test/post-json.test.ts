import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR, postJson, TIMEOUT_ERROR } from "@/lib/post-json";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("postJson", () => {
  it("returns the parsed body of a successful answer and sends JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: "s1" }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const r = await postJson("/api/x", { a: 1 });
    expect(r).toEqual({ ok: true, status: 201, data: { id: "s1" } });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a dropped connection into a readable error instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const r = await postJson("/api/x");
    expect(r).toMatchObject({ ok: false, status: 0, error: NETWORK_ERROR });
  });

  it("turns a timeout into a readable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("signal timed out", "TimeoutError")));
    const r = await postJson("/api/x", {}, { timeoutMs: 5 });
    expect(r).toMatchObject({ ok: false, status: 0, error: TIMEOUT_ERROR });
  });

  it("really aborts a request that never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))),
    );
    const r = await postJson("/api/x", {}, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: TIMEOUT_ERROR });
  });

  it("uses the error text of the server when there is one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Лимит стендов" }, 429)));
    expect(await postJson("/api/x")).toMatchObject({ ok: false, status: 429, error: "Лимит стендов" });
  });

  it("does not show a bare status or a proxy error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 })));
    const r = await postJson("/api/x");
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toContain("Сервер");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 418 })));
    expect(await postJson("/api/x")).toMatchObject({ ok: false, error: "Ошибка 418" });
  });

  it("sends a FormData as is, without a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ status: "UPLOADED" }));
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.set("archive", "x");
    await postJson("/api/up", form);
    const init = fetchMock.mock.calls[0][1];
    expect(init.body).toBe(form);
    expect(init.headers).toBeUndefined();
  });

  it("sends a DELETE without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: "s1" }));
    vi.stubGlobal("fetch", fetchMock);
    await postJson("/api/sessions/s1", undefined, { method: "DELETE" });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});
