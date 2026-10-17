import { describe, expect, it } from "vitest";
import {
  BRAVE_CDP_PORT,
  buildBraveArgs,
  cdpKeyParams,
  findBraveExecutable,
  isStreamingUrl,
  wrapServicePreload,
} from "./brave.js";

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
} as Record<string, string | undefined>;

describe("findBraveExecutable", () => {
  it("prefers the system install on Windows", () => {
    const found = findBraveExecutable("win32", WIN_ENV, (p) =>
      p.includes("Program Files") || p.includes("brave.exe"),
    );
    expect(found).toBe("C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe");
  });

  it("falls back to the per-user install", () => {
    const found = findBraveExecutable("win32", WIN_ENV, (p) => p.includes("AppData\\Local"));
    expect(found).toContain("AppData\\Local\\BraveSoftware");
  });

  it("returns null when Brave is not installed", () => {
    expect(findBraveExecutable("win32", WIN_ENV, () => false)).toBeNull();
    expect(findBraveExecutable("linux", {}, () => false)).toBeNull();
  });

  it("has candidates for linux and macOS", () => {
    expect(findBraveExecutable("linux", {}, (p) => p === "/usr/bin/brave")).toBe("/usr/bin/brave");
    expect(
      findBraveExecutable("darwin", { HOME: "/Users/me" }, (p) => p.startsWith("/Applications")),
    ).toContain("MacOS");
  });
});

describe("buildBraveArgs", () => {
  const base = {
    url: "https://www.netflix.com/",
    userDataDir: "C:\\temp\\brave",
    debugPort: BRAVE_CDP_PORT,
  };

  it("uses app mode with an isolated profile and local-only CDP", () => {
    const args = buildBraveArgs(base);
    expect(args).toContain("--app=https://www.netflix.com/");
    expect(args).toContain("--user-data-dir=C:\\temp\\brave");
    expect(args).toContain(`--remote-debugging-port=${BRAVE_CDP_PORT}`);
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
  });

  it("starts fullscreen for the TV look, but honours an explicit opt-out", () => {
    expect(buildBraveArgs(base)).toContain("--start-fullscreen");
    expect(buildBraveArgs({ ...base, startFullscreen: false })).not.toContain("--start-fullscreen");
  });

  it("sets the media/navigation switches a TV needs", () => {
    const args = buildBraveArgs(base);
    expect(args).toContain("--autoplay-policy=no-user-gesture-required");
    expect(args).toContain("--overscroll-history-navigation=0");
    expect(args).toContain("--no-first-run");
    expect(args.every((a) => a !== "")).toBe(true);
  });
});

describe("cdpKeyParams", () => {
  it("maps the D-pad arrows to CDP arrow keys", () => {
    const up = cdpKeyParams({ type: "keyDown", keyCode: "Up" });
    expect(up).toMatchObject({ key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 });
    const down = cdpKeyParams({ type: "keyUp", keyCode: "Down" });
    expect(down).toMatchObject({ type: "keyUp", key: "ArrowDown", windowsVirtualKeyCode: 40 });
  });

  it("sends non-printable keys as rawKeyDown (no text)", () => {
    const enter = cdpKeyParams({ type: "keyDown", keyCode: "Enter" });
    expect(enter?.type).toBe("rawKeyDown");
    expect(enter?.text).toBeUndefined();
    expect(enter?.windowsVirtualKeyCode).toBe(13);
  });

  it("sends Space as a printable key with text", () => {
    const space = cdpKeyParams({ type: "keyDown", keyCode: "Space" });
    expect(space?.type).toBe("keyDown");
    expect(space?.text).toBe(" ");
    expect(space?.windowsVirtualKeyCode).toBe(32);
  });

  it("encodes Shift+Right (media next) with the shift modifier bit", () => {
    const next = cdpKeyParams({ type: "keyDown", keyCode: "Right", modifiers: ["shift"] });
    expect(next?.modifiers).toBe(8);
    expect(next?.key).toBe("ArrowRight");
  });

  it("maps single letters to physical codes (F = fullscreen)", () => {
    const f = cdpKeyParams({ type: "keyDown", keyCode: "F" });
    expect(f).toMatchObject({ code: "KeyF", windowsVirtualKeyCode: 70 });
    const digit = cdpKeyParams({ type: "keyDown", keyCode: "5" });
    expect(digit).toMatchObject({ code: "Digit5", windowsVirtualKeyCode: 53 });
  });

  it("maps char events to typed text (keyboard entry)", () => {
    const c = cdpKeyParams({ type: "char", keyCode: "a" });
    expect(c).toMatchObject({ type: "char", text: "a", unmodifiedText: "a" });
    expect(c?.windowsVirtualKeyCode).toBe(0);
  });

  it("ignores unknown key names instead of crashing", () => {
    expect(cdpKeyParams({ type: "keyDown", keyCode: "Unidentified" })).toBeNull();
  });
});

describe("wrapServicePreload", () => {
  it("shims CommonJS so the compiled preload runs in the page world", () => {
    const wrapped = wrapServicePreload("exports.hit = 1; typeof document;");
    expect(wrapped.startsWith("(function(){var module={exports:{}};var exports=module.exports;")).toBe(
      true,
    );
    expect(wrapped).toContain("exports.hit = 1;");
    expect(wrapped.endsWith("})();")).toBe(true);
  });

  it("evaluates to a working shim in a sandbox", () => {
    const code = wrapServicePreload(
      "exports.value = 2 + 2; globalThis.__smartvProbe = module.exports;",
    );
    new Function(code)() as void;
    expect((globalThis as { __smartvProbe?: { value: number } }).__smartvProbe?.value).toBe(4);
    delete (globalThis as { __smartvProbe?: unknown }).__smartvProbe;
  });
});

describe("isStreamingUrl", () => {
  const allowed = (h: string) =>
    h.endsWith("netflix.com") || h === "google.com" || h.endsWith(".google.com");
  it("accepts allowlisted https hosts", () => {
    expect(isStreamingUrl("https://www.netflix.com/browse", allowed)).toBe(true);
    expect(isStreamingUrl("https://accounts.google.com/o/oauth", allowed)).toBe(true);
  });
  it("rejects http, unknown hosts and garbage", () => {
    expect(isStreamingUrl("http://www.netflix.com/", allowed)).toBe(false);
    expect(isStreamingUrl("https://evil.example.com/", allowed)).toBe(false);
    expect(isStreamingUrl("not a url", allowed)).toBe(false);
  });
});
