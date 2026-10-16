import { describe, expect, it } from "vitest";
import { isOriginAllowed, normalizeOrigin, parseAllowedOrigins } from "./origins.js";

describe("origin validation", () => {
  it("parses comma-separated origins", () => {
    expect(parseAllowedOrigins("https://a.vercel.app, https://b.vercel.app")).toEqual({
      allowed: ["https://a.vercel.app", "https://b.vercel.app"],
      invalid: [],
    });
  });
  it("allows configured origin", () => {
    expect(isOriginAllowed("https://x.vercel.app", ["https://x.vercel.app"])).toBe(true);
  });
  it("rejects unknown origin", () => {
    expect(isOriginAllowed("https://evil.com", ["https://x.vercel.app"])).toBe(false);
  });
  it("allows missing origin (native agent without Origin header)", () => {
    // Browsers always send Origin; Node.js/Electron `ws` clients don't.
    // The agent authenticates with AGENT_TOKEN after connect, so this only
    // unblocks the PC app without weakening browser controller checks.
    expect(isOriginAllowed(undefined, ["https://x.vercel.app"])).toBe(true);
    expect(isOriginAllowed("", ["https://x.vercel.app"])).toBe(true);
  });
  it("accepts trailing slash and uppercase variants", () => {
    const { allowed } = parseAllowedOrigins("https://x.vercel.app");
    expect(isOriginAllowed("https://x.vercel.app/", allowed)).toBe(true);
    expect(isOriginAllowed("HTTPS://X.VERCEL.APP", allowed)).toBe(true);
  });
  it("flags invalid entries", () => {
    expect(parseAllowedOrigins("not-a-url, https://ok.app")).toEqual({
      allowed: ["https://ok.app"],
      invalid: ["not-a-url"],
    });
  });
  it("normalizes origins", () => {
    expect(normalizeOrigin("  HTTPS://A.App/ ")).toBe("https://a.app");
    expect(normalizeOrigin(undefined)).toBe("");
  });
});
