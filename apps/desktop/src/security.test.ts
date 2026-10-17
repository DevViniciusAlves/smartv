import { describe, expect, it } from "vitest";
import { allowedHosts, appUrl, isAllowedAppId, isAllowedNavigation } from "./security.js";
import { actionScope, actionToStrokes } from "./keys.js";

describe("allowlist", () => {
  it("accepts the four configured app ids and nothing else", () => {
    for (const id of ["youtube", "netflix", "hbo", "disney"]) {
      expect(isAllowedAppId(id)).toBe(true);
      expect(appUrl(id)).toMatch(/^https:\/\//);
    }
    expect(isAllowedAppId("hacker")).toBe(false);
    expect(appUrl("hacker")).toBeUndefined();
    expect(appUrl("https://evil.example")).toBeUndefined();
  });
  it("allows navigation only to service hosts, their subdomains and https", () => {
    expect(isAllowedNavigation("https://www.netflix.com/browse")).toBe(true);
    expect(isAllowedNavigation("https://www.youtube.com/tv")).toBe(true);
    // Bare domain and subdomains work (no need to list each one).
    expect(isAllowedNavigation("https://youtube.com/")).toBe(true);
    expect(isAllowedNavigation("https://accounts.netflix.com/")).toBe(true);
    expect(isAllowedNavigation("http://www.netflix.com/browse")).toBe(false);
    expect(isAllowedNavigation("https://evil.example/phish")).toBe(false);
    expect(isAllowedNavigation("https://netflix.com.evil.example/")).toBe(false);
    expect(isAllowedNavigation("not a url")).toBe(false);
  });
  it("allows the identity providers sign-in flows need", () => {
    // YouTube/Google sign-in.
    expect(isAllowedNavigation("https://accounts.google.com/o/oauth2/auth")).toBe(true);
    // Sign in with Apple / Facebook.
    expect(isAllowedNavigation("https://appleid.apple.com/auth/authorize")).toBe(true);
    expect(isAllowedNavigation("https://www.facebook.com/login")).toBe(true);
    // Disney+ identity backend and HBO/Max auth subdomain.
    expect(isAllowedNavigation("https://cdn.registerdisney.go.com/v3/")).toBe(true);
    expect(isAllowedNavigation("https://auth.hbomax.com/login")).toBe(true);
    // Still no arbitrary third parties.
    expect(isAllowedNavigation("https://evil.example/steal")).toBe(false);
    expect(isAllowedNavigation("https://google.com.evil.example/")).toBe(false);
  });
  it("derives allowed base domains from the shared config", () => {
    const hosts = allowedHosts();
    expect(hosts).toContain("netflix.com");
    expect(hosts).toContain("youtube.com");
    expect(hosts).toContain("google.com");
    expect(hosts).not.toContain("evil.example");
  });
});

describe("key layer", () => {
  it("produces keyDown/keyUp pairs", () => {
    expect(actionToStrokes("up")).toEqual([
      { type: "keyDown", keyCode: "Up" },
      { type: "keyUp", keyCode: "Up" },
    ]);
    expect(actionToStrokes("enter")).toEqual([
      { type: "keyDown", keyCode: "Enter" },
      { type: "keyUp", keyCode: "Enter" },
    ]);
    expect(actionToStrokes("playpause")).toEqual([
      { type: "keyDown", keyCode: "Space" },
      { type: "keyUp", keyCode: "Space" },
    ]);
  });
  it("marks injection scope", () => {
    for (const a of ["up", "enter", "back", "seekForward"] as const) {
      expect(actionScope(a)).toBe("page");
    }
  });
});
