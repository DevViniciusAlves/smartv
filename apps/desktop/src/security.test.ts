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
  it("allows navigation only to service hosts over https", () => {
    expect(isAllowedNavigation("https://www.netflix.com/browse")).toBe(true);
    expect(isAllowedNavigation("https://www.youtube.com/tv")).toBe(true);
    expect(isAllowedNavigation("http://www.netflix.com/browse")).toBe(false);
    expect(isAllowedNavigation("https://evil.example/phish")).toBe(false);
    expect(isAllowedNavigation("https://netflix.com.evil.example/")).toBe(false);
    expect(isAllowedNavigation("not a url")).toBe(false);
  });
  it("derives hosts from the shared config", () => {
    const hosts = allowedHosts();
    expect(hosts).toContain("www.netflix.com");
    expect(hosts).toContain("www.youtube.com");
    expect(hosts.length).toBe(4);
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
