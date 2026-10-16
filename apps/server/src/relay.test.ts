import { describe, expect, it } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "../src/relay.js";

describe("origin validation", () => {
  it("parses comma-separated origins", () => {
    expect(parseAllowedOrigins("https://a.vercel.app, https://b.vercel.app")).toEqual([
      "https://a.vercel.app",
      "https://b.vercel.app",
    ]);
  });
  it("allows configured origin", () => {
    expect(isOriginAllowed("https://x.vercel.app", ["https://x.vercel.app"])).toBe(true);
  });
  it("rejects unknown origin", () => {
    expect(isOriginAllowed("https://evil.com", ["https://x.vercel.app"])).toBe(false);
  });
  it("rejects missing origin when list configured", () => {
    expect(isOriginAllowed(undefined, ["https://x.vercel.app"])).toBe(false);
  });
});
