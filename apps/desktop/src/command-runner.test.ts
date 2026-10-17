import { describe, expect, it } from "vitest";
import { describeAction, systemScriptFor } from "./command-runner.js";

describe("describeAction", () => {
  it("maps home/back to native navigation", () => {
    expect(describeAction({ type: "key", key: "home" })).toEqual({ kind: "go-home" });
    expect(describeAction({ type: "key", key: "back" })).toEqual({ kind: "go-back" });
    expect(describeAction({ type: "app", id: "youtube" })).toEqual({
      kind: "open-app",
      id: "youtube",
    });
  });
  it("maps dpad/media to key presses", () => {
    const up = describeAction({ type: "key", key: "up" });
    expect(up).toMatchObject({ kind: "press" });
    const play = describeAction({ type: "media", action: "playpause" });
    expect(play).toMatchObject({ kind: "press" });
    const next = describeAction({ type: "media", action: "next" });
    expect(next.kind).toBe("press");
  });
  it("maps text to char events (capped)", () => {
    const a = describeAction({ type: "text", value: "olá" });
    expect(a.kind).toBe("press");
    if (a.kind === "press") expect(a.events.length).toBe(3);
    expect(describeAction({ type: "text", value: "" }).kind).toBe("ignore");
    expect(describeAction({ type: "ping" }).kind).toBe("ignore");
  });
  it("maps volume/mouse/power to system actions", () => {
    expect(describeAction({ type: "volume", action: "up" })).toMatchObject({
      kind: "system",
      scriptKind: "vol-up",
    });
    expect(describeAction({ type: "mouseClick", button: "right" })).toMatchObject({
      kind: "system",
      scriptKind: "mouse-click-right",
    });
    expect(describeAction({ type: "power", action: "screenOff" })).toMatchObject({
      kind: "system",
      scriptKind: "screen-off",
    });
  });
});

describe("systemScriptFor", () => {
  it("builds volume/mouse scripts without interpolation of text", () => {
    const vol = systemScriptFor({ kind: "system", scriptKind: "vol-up", step: 3 });
    expect(vol).toContain("$i -lt 3");
    const move = systemScriptFor({ kind: "system", scriptKind: "mouse-move", dx: 10, dy: -5 });
    expect(move).toContain("SetCursorPos");
    expect(move).toContain("10");
    const scroll = systemScriptFor({ kind: "system", scriptKind: "scroll", dy: 0 });
    expect(scroll).toBe("");
  });
  it("clamps steps and moves", () => {
    const vol = systemScriptFor({ kind: "system", scriptKind: "vol-up", step: 999 });
    expect(vol).toContain("$i -lt 10");
    const move = systemScriptFor({ kind: "system", scriptKind: "mouse-move", dx: 99999, dy: 0 });
    expect(move).toContain("2000");
  });
});
