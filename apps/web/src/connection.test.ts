import { describe, expect, it } from "vitest";
import { normalizeBackendUrl, reduceConn, type ConnStatus } from "./connection.js";

describe("normalizeBackendUrl", () => {
  it("converts https to wss and adds /ws", () => {
    expect(normalizeBackendUrl("https://srv.onrender.com")).toEqual({
      url: "wss://srv.onrender.com/ws",
      notes: ["https-to-wss", "path-added"],
    });
  });
  it("converts http to ws", () => {
    expect(normalizeBackendUrl("http://localhost:3001")).toEqual({
      url: "ws://localhost:3001/ws",
      notes: ["http-to-ws", "path-added"],
    });
  });
  it("keeps explicit wss URLs with path", () => {
    expect(normalizeBackendUrl("wss://srv.onrender.com/ws")).toEqual({
      url: "wss://srv.onrender.com/ws",
      notes: [],
    });
  });
  it("adds scheme when missing", () => {
    const { url, notes } = normalizeBackendUrl("srv.onrender.com/ws");
    expect(url).toBe("wss://srv.onrender.com/ws");
    expect(notes).toContain("scheme-added");
  });
  it("rejects empty and invalid values", () => {
    expect(normalizeBackendUrl("").url).toBe("");
    expect(normalizeBackendUrl("   ").notes).toContain("missing");
    expect(normalizeBackendUrl("ftp://x").notes).toContain("invalid");
  });
});

const loading: ConnStatus = { name: "loading", since: 0 };

describe("reduceConn", () => {
  it("loading -> connected on hello_ok", () => {
    expect(reduceConn(loading, { type: "hello_ok", agentOnline: true }, 1)).toEqual({
      name: "connected",
      agentOnline: true,
    });
  });
  it("parks on 4401 without retry", () => {
    expect(reduceConn(loading, { type: "closed", code: 4401 }, 1)).toEqual({
      name: "error",
      kind: "auth",
      autoRetry: false,
    });
  });
  it("parks on 4403 without retry", () => {
    expect(reduceConn(loading, { type: "closed", code: 4403 }, 1)).toEqual({
      name: "error",
      kind: "origin",
      autoRetry: false,
    });
  });
  it("goes back to loading on network close", () => {
    const next = reduceConn(loading, { type: "closed", code: 1006 }, 99);
    expect(next).toEqual({ name: "loading", since: 0 });
    const fromConnected = reduceConn(
      { name: "connected", agentOnline: true },
      { type: "closed", code: 1006 },
      99,
    );
    expect(fromConnected).toEqual({ name: "loading", since: 99 });
  });
  it("never gives up: a network close always schedules another retry", () => {
    // Same close, late in a failure streak, still returns to loading so the
    // manager keeps retrying (the phone must not require the code again).
    const early = reduceConn({ name: "loading", since: 0 }, { type: "closed", code: 1006 }, 1);
    const late = reduceConn({ name: "connected", agentOnline: true }, { type: "closed", code: 1006 }, 999999);
    expect(early.name).toBe("loading");
    expect(late.name).toBe("loading");
  });
  it("state updates agent presence", () => {
    expect(
      reduceConn({ name: "connected", agentOnline: false }, { type: "state", agentOnline: true }, 1),
    ).toEqual({ name: "connected", agentOnline: true });
  });
});
