import { describe, expect, it } from "vitest";
import { isSameOrigin, readBodyCapped, readJson, tooMany } from "@/lib/http";

const post = (headers: Record<string, string>, body?: string) => new Request("http://web.test/api/x", { method: "POST", headers, body });

describe("isSameOrigin", () => {
  it("accepts an Origin equal to the Host header", () => {
    expect(isSameOrigin(post({ origin: "https://game.example.com", host: "game.example.com" }))).toBe(true);
  });

  it("accepts an Origin equal to X-Forwarded-Host", () => {
    expect(isSameOrigin(post({ origin: "https://game.example.com", host: "web:3000", "x-forwarded-host": "game.example.com" }))).toBe(true);
  });

  it("refuses a foreign Origin, including a sibling subdomain", () => {
    expect(isSameOrigin(post({ origin: "https://evil.example.com", host: "game.example.com" }))).toBe(false);
    expect(isSameOrigin(post({ origin: "https://evil.example", host: "game.example.com" }))).toBe(false);
  });

  it("refuses an opaque or malformed Origin", () => {
    expect(isSameOrigin(post({ origin: "null", host: "game.example.com" }))).toBe(false);
  });

  it("without Origin decides by Sec-Fetch-Site and lets non-browser clients through", () => {
    expect(isSameOrigin(post({ host: "game.example.com" }))).toBe(true);
    expect(isSameOrigin(post({ host: "game.example.com", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(post({ host: "game.example.com", "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOrigin(post({ host: "game.example.com", "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});

describe("readBodyCapped", () => {
  it("refuses a declared length over the limit without reading", async () => {
    expect(await readBodyCapped(post({ "content-length": "1000" }, "x"), 10)).toBeNull();
  });

  it("stops a body without a length as soon as it crosses the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    const req = new Request("http://web.test/api/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readBodyCapped(req, 10)).toBeNull();
  });

  it("returns the whole body when it fits", async () => {
    const bytes = await readBodyCapped(post({}, "hello"), 10);
    expect(new TextDecoder().decode(bytes!)).toBe("hello");
  });
});

describe("readJson", () => {
  const json = (body: string) => post({ "content-type": "application/json" }, body);

  it("parses a small body", async () => {
    const r = await readJson<{ a: number }>(json('{"a":1}'));
    expect(r.ok && r.data.a).toBe(1);
  });

  it("answers 413 for a body over maxBytes", async () => {
    const r = await readJson(json(JSON.stringify({ a: "x".repeat(100) })), { maxBytes: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const r = await readJson(json("{nope"));
    expect(r.ok === false && r.response.status).toBe(400);
  });
});

describe("tooMany", () => {
  it("sets Retry-After and names the wait in Russian", async () => {
    const res = tooMany(45_000, "Слишком много запусков.");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("45");
    expect((await res.json()).error).toBe("Слишком много запусков. Попробуй через 45 с.");
  });
});
