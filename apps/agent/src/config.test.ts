import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    BACKEND_URL: "wss://example.test/ws",
    AGENT_TOKEN: "secret",
    ...extra,
  };
}

describe("loadConfig", () => {
  it("loads required fields with defaults", () => {
    const c = loadConfig(env({}));
    expect(c.backendUrl).toBe("wss://example.test/ws");
    expect(c.tvTarget).toBe("edge");
    expect(c.tvMode).toBe("kiosk");
    expect(c.cdpPort).toBe(9222);
    expect(c.backBehavior).toBe("alt-left");
  });
  it("accepts electron target", () => {
    expect(loadConfig(env({ TV_TARGET: "electron" })).tvTarget).toBe("electron");
  });
  it("falls back to edge on invalid target", () => {
    expect(loadConfig(env({ TV_TARGET: "chrome" })).tvTarget).toBe("edge");
  });
  it("rejects out-of-range CDP ports and defaults non-numeric ones", () => {
    for (const bad of ["80", "99999"]) {
      expect(() => loadConfig(env({ CDP_PORT: bad }))).toThrow();
    }
    expect(loadConfig(env({ CDP_PORT: "abc" })).cdpPort).toBe(9222);
  });
  it("requires backend url and token", () => {
    expect(() => loadConfig(env({ BACKEND_URL: "" }))).toThrow();
    expect(() => loadConfig(env({ AGENT_TOKEN: "" }))).toThrow();
  });
});
