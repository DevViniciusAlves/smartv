import { describe, expect, it } from "vitest";
import type { ControllerMessage } from "@smartv/shared";
import { STREAMING_APPS } from "@smartv/shared";
import type { AgentConfig } from "./config.js";
import type { Automation, KeyName, Modifier, MouseButton } from "./automation.js";
import type { BrowserNavigator } from "./browser.js";
import { handleCommand } from "./commands.js";

class FakeAutomation implements Automation {
  calls: string[] = [];
  async tap(key: KeyName): Promise<void> {
    this.calls.push(`tap:${key}`);
  }
  async combo(mods: Modifier[], key: KeyName): Promise<void> {
    this.calls.push(`combo:${mods.join("+")}+${key}`);
  }
  async typeViaClipboard(text: string): Promise<void> {
    this.calls.push(`type:${text.length}`);
  }
  async backspace(): Promise<void> {
    this.calls.push("backspace");
  }
  async moveMouse(dx: number, dy: number): Promise<void> {
    this.calls.push(`move:${dx},${dy}`);
  }
  async click(button: MouseButton): Promise<void> {
    this.calls.push(`click:${button}`);
  }
  async scroll(dy: number): Promise<void> {
    this.calls.push(`scroll:${dy}`);
  }
  async volumeUp(step = 2): Promise<void> {
    this.calls.push(`volUp:${step}`);
  }
  async volumeDown(step = 2): Promise<void> {
    this.calls.push(`volDown:${step}`);
  }
  async volumeMute(): Promise<void> {
    this.calls.push("mute");
  }
  async screenOff(): Promise<void> {
    this.calls.push("screenOff");
  }
}

class FakeBrowser implements BrowserNavigator {
  navigated: string[] = [];
  async navigate(url: string): Promise<boolean> {
    this.navigated.push(url);
    return true;
  }
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    backendUrl: "ws://127.0.0.1:1/ws",
    agentToken: "test",
    browserPath: "edge",
    browserProfileDir: "profile",
    launcherUrl: "https://example.com/tv",
    tvWindowX: 0,
    tvWindowY: 0,
    backBehavior: "alt-left",
    tvMode: "kiosk",
    tvTarget: "edge",
    cdpPort: 9222,
    ...overrides,
  };
}

async function run(msg: ControllerMessage, config?: AgentConfig): Promise<{ auto: FakeAutomation; tv: FakeBrowser }> {
  const auto = new FakeAutomation();
  const tv = new FakeBrowser();
  await handleCommand(auto, config ?? baseConfig(), tv, msg);
  return { auto, tv };
}

describe("handleCommand", () => {
  it("maps dpad keys to tap", async () => {
    for (const [key, tap] of [
      ["up", "up"],
      ["down", "down"],
      ["left", "left"],
      ["right", "right"],
      ["enter", "enter"],
    ] as const) {
      const { auto } = await run({ type: "key", key });
      expect(auto.calls).toEqual([`tap:${tap}`]);
    }
  });
  it("maps back to alt+left by default", async () => {
    const { auto } = await run({ type: "key", key: "back" });
    expect(auto.calls).toEqual(["combo:alt+left"]);
  });
  it("maps back to esc when configured", async () => {
    const { auto } = await run({ type: "key", key: "back" }, baseConfig({ backBehavior: "esc" }));
    expect(auto.calls).toEqual(["tap:esc"]);
  });
  it("maps back/home to esc in electron mode", async () => {
    const cfg = baseConfig({ tvTarget: "electron" });
    expect((await run({ type: "key", key: "back" }, cfg)).auto.calls).toEqual(["tap:esc"]);
    const home = await run({ type: "key", key: "home" }, cfg);
    expect(home.auto.calls).toEqual(["tap:esc"]);
    expect(home.tv.navigated).toEqual([]);
  });
  it("maps home to launcher navigation (no fullscreen key)", async () => {
    const { auto, tv } = await run({ type: "key", key: "home" });
    expect(tv.navigated).toEqual(["https://example.com/tv"]);
    expect(auto.calls).toEqual([]);
  });
  it("maps media actions", async () => {
    const cases: Array<[ControllerMessage, string]> = [
      [{ type: "media", action: "playpause" }, "tap:space"],
      [{ type: "media", action: "play" }, "tap:space"],
      [{ type: "media", action: "pause" }, "tap:space"],
      [{ type: "media", action: "seekForward" }, "tap:right"],
      [{ type: "media", action: "seekBackward" }, "tap:left"],
      [{ type: "media", action: "fullscreen" }, "tap:f"],
      [{ type: "media", action: "next" }, "combo:shift+right"],
    ];
    for (const [msg, expected] of cases) {
      const { auto } = await run(msg);
      expect(auto.calls).toEqual([expected]);
    }
  });
  it("maps volume actions", async () => {
    expect((await run({ type: "volume", action: "up" })).auto.calls).toEqual(["volUp:2"]);
    expect((await run({ type: "volume", action: "up", step: 5 })).auto.calls).toEqual(["volUp:5"]);
    expect((await run({ type: "volume", action: "down" })).auto.calls).toEqual(["volDown:2"]);
    expect((await run({ type: "volume", action: "mute" })).auto.calls).toEqual(["mute"]);
  });
  it("maps app shortcuts to whitelisted URLs", async () => {
    for (const app of STREAMING_APPS) {
      const { auto, tv } = await run({ type: "app", id: app.id });
      expect(tv.navigated).toEqual([app.url]);
      expect(auto.calls).toEqual([]);
    }
  });
  it("maps text and text keys", async () => {
    expect((await run({ type: "text", value: "olá" })).auto.calls).toEqual(["type:3"]);
    expect((await run({ type: "textKey", key: "backspace" })).auto.calls).toEqual(["backspace"]);
    expect((await run({ type: "textKey", key: "enter" })).auto.calls).toEqual(["tap:enter"]);
  });
  it("clamps mouse movement", async () => {
    const { auto } = await run({ type: "mouseMove", dx: 9999, dy: -9999 });
    expect(auto.calls).toEqual(["move:2000,-2000"]);
  });
  it("maps click, scroll and power", async () => {
    expect((await run({ type: "mouseClick", button: "left" })).auto.calls).toEqual(["click:left"]);
    expect((await run({ type: "mouseClick", button: "right" })).auto.calls).toEqual(["click:right"]);
    expect((await run({ type: "scroll", dy: 120 })).auto.calls).toEqual(["scroll:120"]);
    expect((await run({ type: "power", action: "screenOff" })).auto.calls).toEqual(["screenOff"]);
  });
});
