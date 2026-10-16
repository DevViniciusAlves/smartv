import { describe, expect, it } from "vitest";
import { parseCdpPort } from "./cdp.js";

describe("parseCdpPort", () => {
  it("returns null when absent", () => {
    expect(parseCdpPort(["electron", "."])).toBeNull();
  });
  it("parses a valid port", () => {
    expect(parseCdpPort(["electron", ".", "--smartv-cdp=9222"])).toBe(9222);
  });
  it("throws on invalid ports", () => {
    for (const bad of ["--smartv-cdp=80", "--smartv-cdp=99999", "--smartv-cdp=abc", "--smartv-cdp="]) {
      expect(() => parseCdpPort(["x", bad])).toThrow();
    }
  });
});
