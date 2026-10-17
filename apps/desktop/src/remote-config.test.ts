import { describe, expect, it } from "vitest";
import {
  maskToken,
  normalizeRemoteUrl,
  parseRemoteArgs,
  resolveRemoteConfig,
} from "./remote-config.js";

describe("parseRemoteArgs", () => {
  it("parses backend/token/off flags", () => {
    expect(
      parseRemoteArgs(["--smartv-backend=wss://srv/ws", "--smartv-agent-token=abc"]),
    ).toEqual({ backend: "wss://srv/ws", token: "abc", disabled: false });
    expect(parseRemoteArgs(["--smartv-remote-off"]).disabled).toBe(true);
  });
});

describe("normalizeRemoteUrl", () => {
  it("adds scheme and /ws", () => {
    expect(normalizeRemoteUrl("srv.onrender.com")).toBe("wss://srv.onrender.com/ws");
    expect(normalizeRemoteUrl("https://srv.onrender.com")).toBe("wss://srv.onrender.com/ws");
    expect(normalizeRemoteUrl("wss://srv.onrender.com/ws")).toBe("wss://srv.onrender.com/ws");
    expect(normalizeRemoteUrl("")).toBe("");
    expect(normalizeRemoteUrl("ftp://x")).toBe("");
  });
});

describe("resolveRemoteConfig", () => {
  it("prefers CLI over env and file", () => {
    const r = resolveRemoteConfig(
      ["--smartv-backend=wss://cli/ws", "--smartv-agent-token=t1"],
      { SMARTV_BACKEND_URL: "wss://env/ws", SMARTV_AGENT_TOKEN: "t2" },
      { backendUrl: "wss://file/ws", agentToken: "t3" },
    );
    expect(r).toMatchObject({ enabled: true, source: "cli", backendUrl: "wss://cli/ws" });
  });
  it("falls back to env then file", () => {
    const fromEnv = resolveRemoteConfig([], { BACKEND_URL: "wss://e/ws", AGENT_TOKEN: "t" }, {});
    expect(fromEnv).toMatchObject({ enabled: true, source: "env" });
    const fromFile = resolveRemoteConfig([], {}, { backendUrl: "wss://f/ws", agentToken: "t" });
    expect(fromFile).toMatchObject({ enabled: true, source: "file" });
  });
  it("disables with flag and reports incomplete config", () => {
    expect(resolveRemoteConfig(["--smartv-remote-off"], {}, {}).enabled).toBe(false);
    expect(resolveRemoteConfig([], {}, {}).enabled).toBe(false);
    // Half config (URL without token) is disabled but keeps the source.
    expect(
      resolveRemoteConfig([], { SMARTV_BACKEND_URL: "wss://e/ws" }, {}),
    ).toMatchObject({ enabled: false, source: "env" });
  });
  it("falls back to baked-in defaults for a zero-config install", () => {
    const baked = { backendUrl: "wss://baked/ws", agentToken: "baked-tok" };
    const fresh = resolveRemoteConfig([], {}, {}, baked);
    expect(fresh).toMatchObject({
      enabled: true,
      source: "default",
      backendUrl: "wss://baked/ws",
      agentToken: "baked-tok",
    });
    // Any explicit source still wins; defaults only fill the gaps.
    expect(
      resolveRemoteConfig([], {}, { backendUrl: "wss://f/ws", agentToken: "t" }, baked),
    ).toMatchObject({ enabled: true, source: "file", backendUrl: "wss://f/ws" });
    expect(resolveRemoteConfig([], {}, { backendUrl: "wss://f/ws" }, baked)).toMatchObject({
      enabled: true,
      backendUrl: "wss://f/ws",
      agentToken: "baked-tok",
    });
  });
});

describe("maskToken", () => {
  it("never returns the full token", () => {
    const t = "supersecrettoken123";
    const m = maskToken(t);
    expect(m).not.toContain(t);
    expect(m).toContain("***");
    expect(maskToken("")).toBe("(não definido)");
  });
});
