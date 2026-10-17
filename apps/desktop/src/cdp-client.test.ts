import { describe, expect, it, vi } from "vitest";
import { CdpConnection, type WebSocketLike } from "./cdp-client.js";

function fakeSocket(): WebSocketLike & {
  handlers: Record<string, (...args: never[]) => void>;
  sent: string[];
  emit(msg: unknown): void;
} {
  const handlers: Record<string, (...args: never[]) => void> = {};
  const sent: string[] = [];
  return {
    handlers,
    sent,
    send: (d: string) => void sent.push(d),
    close: () => void handlers.close?.(),
    on: (ev: string, cb: (...args: never[]) => void) => void (handlers[ev] = cb),
    emit(msg: unknown) {
      handlers.message?.(JSON.stringify(msg) as never);
    },
  };
}

describe("CdpConnection", () => {
  it("resolves a response by id", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    const p = conn.send("Page.navigate", { url: "https://x" });
    expect(ws.sent.length).toBe(1);
    const req = JSON.parse(ws.sent[0]) as { id: number; method: string; params: unknown };
    expect(req.method).toBe("Page.navigate");
    expect(req.params).toEqual({ url: "https://x" });
    ws.emit({ id: req.id, result: { frameId: "f1" } });
    await expect(p).resolves.toEqual({ frameId: "f1" });
  });

  it("increments ids across calls", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    const a = conn.send("A");
    const b = conn.send("B");
    const ids = ws.sent.map((s) => (JSON.parse(s) as { id: number }).id);
    expect(ids[1]).toBe(ids[0] + 1);
    ws.emit({ id: ids[0], result: {} });
    ws.emit({ id: ids[1], result: {} });
    await Promise.all([a, b]);
  });

  it("rejects when the response carries an error", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    const p = conn.send("X");
    const id = (JSON.parse(ws.sent[0]) as { id: number }).id;
    ws.emit({ id, error: { message: "nope" } });
    await expect(p).rejects.toThrow("nope");
  });

  it("carries the session id for flattened page commands", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    void conn.send("Input.dispatchKeyEvent", { type: "keyDown" }, "sess-1");
    const req = JSON.parse(ws.sent[0]) as { sessionId?: string };
    expect(req.sessionId).toBe("sess-1");
  });

  it("fans events out to subscribers and supports unsubscribe", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    const seen: string[] = [];
    const off = conn.on("Page.frameNavigated", (p) =>
      void seen.push(String((p.frame as { url?: string })?.url)),
    );
    ws.emit({ method: "Page.frameNavigated", params: { frame: { url: "https://a" } } });
    off();
    ws.emit({ method: "Page.frameNavigated", params: { frame: { url: "https://b" } } });
    expect(seen).toEqual(["https://a"]);
  });

  it("rejects pending calls when the socket closes", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    const p = conn.send("Slow");
    ws.handlers.close();
    await expect(p).rejects.toThrow("closed");
  });

  it("ignores malformed frames and unknown ids", () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    expect(() => ws.emit("{ not json")).not.toThrow();
    expect(() => ws.emit({ id: 9999, result: {} })).not.toThrow();
    expect(() => conn.close()).not.toThrow();
  });

  it("rejects sends after close", async () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    conn.close();
    await expect(conn.send("X")).rejects.toThrow("closed");
  });

  it("does not let a throwing listener break the socket", () => {
    const ws = fakeSocket();
    const conn = new CdpConnection(ws);
    conn.on("Ev", () => {
      throw new Error("listener boom");
    });
    const spy = vi.fn();
    conn.on("Ev", spy);
    expect(() => ws.emit({ method: "Ev", params: {} })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
