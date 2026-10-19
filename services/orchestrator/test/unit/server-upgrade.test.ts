// The WebSocket upgrade handler runs outside any promise chain: whatever it throws or emits unhandled takes the process down.
import { EventEmitter } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/logger";
import { createServer } from "../../src/server";
import type { SessionService } from "../../src/sessions";
import { TerminalTokenStore } from "../../src/terminal-tokens";

const make = () =>
  createServer({
    sessions: { isDraining: () => false } as unknown as SessionService,
    tokens: new TerminalTokenStore(60_000),
    internalToken: "t",
    activeSessionCount: async () => 0,
  });

afterEach(() => vi.restoreAllMocks());

describe("upgrade handler", () => {
  it("survives a request target that URL cannot parse, closes the socket and logs it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const server = make();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn() });
    expect(() => server.emit("upgrade", { url: "//" }, socket, Buffer.alloc(0))).not.toThrow();
    expect(socket.destroy).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ url: "//" }), "terminal upgrade rejected");
  });

  it("has a listener for socket errors, so a reset connection is not an uncaught exception", () => {
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    const server = make();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn() });
    server.emit("upgrade", { url: "/nothing" }, socket, Buffer.alloc(0));
    // an EventEmitter throws on 'error' without a listener: that is exactly what happens to a raw socket
    expect(() => socket.emit("error", new Error("read ECONNRESET"))).not.toThrow();
  });

  it("answers a real malformed upgrade request by closing the connection, and keeps serving", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const server = make();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const c = net.connect(port, "127.0.0.1", () => c.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
        c.on("close", () => resolve(true));
        c.on("error", () => {});
        setTimeout(() => resolve(false), 2000).unref();
      });
      expect(closed).toBe(true);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
