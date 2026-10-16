import { describe, expect, it } from "vitest";
import { ABORTED, LOAD_ERROR_TEXT, ViewRouter } from "./router.js";

const NETFLIX = "https://www.netflix.com";
const DISNEY = "https://www.disneyplus.com";

describe("ViewRouter home -> service -> home -> other service", () => {
  it("opens a service and returns home", () => {
    const r = new ViewRouter();
    expect(r.openApp("netflix", NETFLIX)).toEqual({
      surface: "service",
      appId: "netflix",
      status: "Abrindo netflix…",
    });
    expect(r.onStarted().status).toBe("Carregando…");
    expect(r.onStopped()).toEqual({ surface: "service", appId: "netflix", status: "netflix" });
    expect(r.goHome()).toEqual({ surface: "home", appId: null, status: "" });
  });
  it("switches netflix -> disney predictably", () => {
    const r = new ViewRouter();
    r.openApp("netflix", NETFLIX);
    r.onStopped();
    r.openApp("disney", DISNEY);
    expect(r.snapshot()).toEqual({ surface: "service", appId: "disney", status: "Abrindo disney…" });
    r.onStopped();
    expect(r.snapshot().appId).toBe("disney");
  });
  it("ignores aborted navigations (fast switch, double click, redirects)", () => {
    const r = new ViewRouter();
    r.openApp("disney", DISNEY);
    expect(r.onFailed(ABORTED, true, DISNEY)).toEqual({
      surface: "service",
      appId: "disney",
      status: "Abrindo disney…",
    });
  });
  it("treats a genuine failure as home + error", () => {
    const r = new ViewRouter();
    r.openApp("disney", DISNEY);
    expect(r.onFailed(-105, true, DISNEY)).toEqual({
      surface: "home",
      appId: null,
      status: LOAD_ERROR_TEXT,
    });
  });
  it("ignores stale failures from a previous navigation (urls)", () => {
    const r = new ViewRouter();
    r.openApp("netflix", NETFLIX);
    r.openApp("disney", DISNEY);
    // Late genuine failure of the old navigation: not ours anymore.
    expect(r.onFailed(-105, true, NETFLIX)).toEqual({
      surface: "service",
      appId: "disney",
      status: "Abrindo disney…",
    });
  });
  it("ignores failures once already home", () => {
    const r = new ViewRouter();
    r.openApp("disney", DISNEY);
    r.goHome();
    expect(r.onFailed(-105, true, DISNEY)).toEqual({ surface: "home", appId: null, status: "" });
  });
  it("ignores subframe failures", () => {
    const r = new ViewRouter();
    r.openApp("disney", DISNEY);
    expect(r.onFailed(-105, false, DISNEY).surface).toBe("service");
  });
  it("does not show loading status for background loads", () => {
    const r = new ViewRouter();
    r.openApp("disney", DISNEY);
    r.goHome();
    expect(r.onStarted().status).toBe("");
    expect(r.onStopped().status).toBe("");
  });
});
